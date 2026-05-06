import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { Readable } from 'node:stream';

type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/** Messages API allows string or structured blocks (required for pause_turn continuation). */
type ApiMessage = {
  role: 'user' | 'assistant';
  content: string | unknown[];
};

type ClaudeGenerateTextParams = {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  messages?: ClaudeMessage[];
};

/** Safe log line for Anthropic/axios failures — never includes API key or full request config. */
export function summarizeClaudeHttpError(error: unknown): string {
  const ax = error as {
    code?: string;
    response?: {
      status?: number;
      data?: { error?: { type?: string; message?: string } };
    };
    message?: string;
  };
  const status = ax.response?.status;
  const apiErr = ax.response?.data?.error;
  if (apiErr?.message) {
    return `HTTP ${status ?? '?'} ${apiErr.type ?? 'error'}: ${apiErr.message}`;
  }
  if (ax.code) {
    return `${ax.code}${ax.message ? `: ${ax.message}` : ''}`;
  }
  if (ax.message) return ax.message;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientClaudeNetworkError(error: unknown): boolean {
  const ax = error as {
    code?: string;
    message?: string;
    response?: { status?: number };
  };
  const status = ax.response?.status;
  if (status === 502 || status === 503 || status === 504) return true;
  if (status != null && status < 500) return false;
  const code = ax.code;
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  const msg = (ax.message || '').toLowerCase();
  return msg.includes('socket hang up') || msg.includes('network error');
}

/** Anthropic returned 400 — org may not have server tools enabled in Console. */
function isServerToolRejectedError(error: unknown): boolean {
  const ax = error as {
    response?: { status?: number; data?: { error?: { message?: string } } };
  };
  if (ax.response?.status !== 400) return false;
  const msg = (ax.response?.data?.error?.message || '').toLowerCase();
  return (
    msg.includes('tool') ||
    msg.includes('web_search') ||
    msg.includes('web fetch') ||
    msg.includes('server tool')
  );
}

function extractTextFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

/** Parts compatible with AI SDK stream shape used in ChatService. */
export type ClaudeStreamYield =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string }
  | { type: 'tool-result'; toolName: string };

async function readSseEvents(stream: Readable): AsyncGenerator<{
  eventName?: string;
  data: string;
}> {
  let buf = '';
  for await (const chunk of stream) {
    buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      if (!raw.trim()) continue;
      let eventName: string | undefined;
      const dataLines: string[] = [];
      for (const line of raw.split(/\n')) {
        const l = line.replace(/\r$/, '');
        if (l.startsWith('event:')) eventName = l.slice(6).trim();
        else if (l.startsWith('data:')) dataLines.push(l.slice(5).trimStart());
      }
      if (dataLines.length) {
        yield { eventName, data: dataLines.join('\n') };
      }
    }
  }
}

async function readStreamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function finalizeAssistantBlocks(
  blocks: Record<number, Record<string, unknown>>,
): unknown[] {
  return Object.keys(blocks)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((k) => {
      const o = { ...blocks[k] };
      delete o._partialJson;
      return o;
    });
}

@Injectable()
export class ClaudeAiService {
  private readonly logger = new Logger(ClaudeAiService.name);
  /** Current Claude Sonnet on the Messages API; 3.5 Sonnet aliases (e.g. *-latest) are retired — see https://docs.anthropic.com/en/docs/about-claude/models/overview */
  private static readonly DEFAULT_MODEL = 'claude-sonnet-4-6';
  private static readonly API_URL = 'https://api.anthropic.com/v1/messages';
  /** Match HttpModule in claude-ai.module; explicit per-request so behavior stays obvious. */
  private static readonly REQUEST_TIMEOUT_MS = 600_000;
  private static readonly MAX_ATTEMPTS = 3;
  /** Server-side web search/fetch may pause the turn; see https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/server-tools */
  private static readonly MAX_PAUSE_TURN_ROUNDS = 16;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  isConfigured(): boolean {
    return !!this.configService.get<string>('CLAUDE_API_KEY');
  }

  getModel(): string {
    const model = this.configService.get<string>('CLAUDE_MODEL')?.trim();
    return model && model.length > 0 ? model : ClaudeAiService.DEFAULT_MODEL;
  }

  /**
   * When true, the streaming UI may show the same "searching" affordance as Valyu on the gateway path.
   * With {@link streamGenerateText}, native web tool phases emit real tool-call / tool-result events.
   */
  shouldSurfaceWebToolUi(): boolean {
    const tools = this.buildServerTools();
    return tools != null && tools.length > 0;
  }

  /** When false, chat falls back to one-shot Claude then gateway (legacy). Default: true. */
  isStreamingEnabled(): boolean {
    return (
      (this.configService.get<string>('CLAUDE_STREAMING_ENABLED') ?? 'true')
        .trim()
        .toLowerCase() !== 'false'
    );
  }

  /**
   * Anthropic-native server tools: web search + URL fetch (no client-side scraping).
   * Enable in the Anthropic Console; see https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
   */
  private buildServerTools(): Record<string, unknown>[] | undefined {
    if (!this.isConfigured()) return undefined;

    const searchOn =
      (this.configService.get<string>('CLAUDE_WEB_SEARCH_ENABLED') ?? 'true')
        .trim()
        .toLowerCase() !== 'false';
    const fetchOn =
      (this.configService.get<string>('CLAUDE_WEB_FETCH_ENABLED') ?? 'true')
        .trim()
        .toLowerCase() !== 'false';

    const domains = this.parseAllowedDomains();
    const tools: Record<string, unknown>[] = [];

    if (searchOn) {
      const maxUses = this.parsePositiveInt(
        this.configService.get<string>('CLAUDE_WEB_SEARCH_MAX_USES'),
        10,
      );
      const t: Record<string, unknown> = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxUses,
      };
      if (domains?.length) t.allowed_domains = domains;
      tools.push(t);
    }

    if (fetchOn) {
      const maxUses = this.parsePositiveInt(
        this.configService.get<string>('CLAUDE_WEB_FETCH_MAX_USES'),
        5,
      );
      const t: Record<string, unknown> = {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: maxUses,
      };
      if (domains?.length) t.allowed_domains = domains;
      tools.push(t);
    }

    return tools.length > 0 ? tools : undefined;
  }

  private parseAllowedDomains(): string[] | undefined {
    const raw = this.configService
      .get<string>('CLAUDE_WEB_ALLOWED_DOMAINS')
      ?.trim();
    if (!raw) return undefined;
    const list = raw
      .split(',')
      .map((s) => s.trim().replace(/^https?:\/\//i, ''))
      .filter(Boolean);
    return list.length ? list : undefined;
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /**
   * Token-accurate streaming for the Messages API (text deltas + server web_search / web_fetch signals).
   * Handles `pause_turn` (server tools) by continuing with accumulated assistant blocks; see Anthropic server tools docs.
   */
  async *streamGenerateText(
    params: ClaudeGenerateTextParams,
  ): AsyncGenerator<ClaudeStreamYield> {
    const apiKey = this.configService.get<string>('CLAUDE_API_KEY');
    if (!apiKey) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    const {
      prompt,
      system,
      maxTokens: maxTokensParam = 1024,
      temperature = 0.2,
      messages = [],
    } = params;

    const historyMessages: ApiMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const initialConversation: ApiMessage[] = [
      ...historyMessages,
      { role: 'user', content: prompt },
    ];

    let useServerTools = true;
    for (let toolRetry = 0; toolRetry < 2; toolRetry++) {
      const tools = useServerTools ? this.buildServerTools() : undefined;
      const max_tokens = tools
        ? Math.max(maxTokensParam, 4096)
        : maxTokensParam;

      for (
        let attempt = 1;
        attempt <= ClaudeAiService.MAX_ATTEMPTS;
        attempt++
      ) {
        try {
          let conversationMessages = initialConversation;

          for (
            let pauseRound = 0;
            pauseRound < ClaudeAiService.MAX_PAUSE_TURN_ROUNDS;
            pauseRound++
          ) {
            const payload: Record<string, unknown> = {
              model: this.getModel(),
              max_tokens,
              temperature,
              messages: conversationMessages,
              stream: true,
            };
            if (system !== undefined) payload.system = system;
            if (tools?.length) payload.tools = tools;

            const sseStream = await this.openAnthropicMessageStream(
              apiKey,
              payload,
            );

            const acc: {
              blocks: Record<number, Record<string, unknown>>;
              stopReason?: string;
            } = { blocks: {} };

            for await (const part of this.yieldFromAnthropicSse(sseStream, acc)) {
              yield part;
            }

            if (acc.stopReason !== 'pause_turn') {
              return;
            }

            const assistantBlocks = finalizeAssistantBlocks(acc.blocks);
            conversationMessages = [
              ...conversationMessages,
              { role: 'assistant', content: assistantBlocks },
            ];
            this.logger.debug(
              `Claude streaming pause_turn ${pauseRound + 1}/${ClaudeAiService.MAX_PAUSE_TURN_ROUNDS}`,
            );
          }

          this.logger.warn(
            'Claude streaming: stop_reason pause_turn persisted after max continuation rounds',
          );
          return;
        } catch (error: unknown) {
          if (
            toolRetry === 0 &&
            useServerTools &&
            isServerToolRejectedError(error)
          ) {
            this.logger.warn(
              'Anthropic server tools rejected during stream; retrying without native web tools.',
            );
            useServerTools = false;
            break;
          }

          const summary = summarizeClaudeHttpError(error);
          const retriable =
            attempt < ClaudeAiService.MAX_ATTEMPTS &&
            isTransientClaudeNetworkError(error);
          if (retriable) {
            this.logger.warn(
              `Claude streaming attempt ${attempt}/${ClaudeAiService.MAX_ATTEMPTS} failed (${summary}), retrying…`,
            );
            await delay(400 * attempt);
            continue;
          }
          throw error;
        }
      }
    }
  }

  private async openAnthropicMessageStream(
    apiKey: string,
    payload: Record<string, unknown>,
  ): Promise<Readable> {
    const response = await firstValueFrom(
      this.httpService.post<Readable>(ClaudeAiService.API_URL, payload, {
        responseType: 'stream',
        timeout: ClaudeAiService.REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }),
    );

    if (response.status !== 200) {
      const body = await readStreamToString(response.data as Readable);
      let err: Error & { response?: { status: number; data: unknown } };
      try {
        const j = JSON.parse(body) as {
          error?: { type?: string; message?: string };
        };
        const msg = j.error?.message ?? body;
        err = Object.assign(new Error(msg), {
          response: { status: response.status, data: j },
        });
      } catch {
        err = Object.assign(new Error(body.slice(0, 500)), {
          response: { status: response.status, data: body },
        });
      }
      throw err;
    }

    return response.data as Readable;
  }

  private async *yieldFromAnthropicSse(
    stream: Readable,
    acc: {
      blocks: Record<number, Record<string, unknown>>;
      stopReason?: string;
    },
  ): AsyncGenerator<ClaudeStreamYield> {
    for await (const { data: dataStr } of readSseEvents(stream)) {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        continue;
      }
      const t = d.type as string | undefined;
      if (!t) continue;

      if (t === 'content_block_start') {
        const idx = d.index as number;
        const cb = d.content_block as Record<string, unknown> | undefined;
        if (!cb) continue;
        acc.blocks[idx] = { ...cb };
        if (cb.type === 'server_tool_use') {
          const name = cb.name as string;
          if (name === 'web_search' || name === 'web_fetch') {
            yield { type: 'tool-call', toolName: 'webSearch' };
          }
        }
        if (
          cb.type === 'web_search_tool_result' ||
          cb.type === 'web_fetch_tool_result'
        ) {
          yield { type: 'tool-result', toolName: 'webSearch' };
        }
      }

      if (t === 'content_block_delta') {
        const idx = d.index as number;
        const delta = d.delta as Record<string, unknown> | undefined;
        const b = acc.blocks[idx];
        if (
          delta?.type === 'text_delta' &&
          typeof delta.text === 'string' &&
          b?.type === 'text'
        ) {
          b.text = String(b.text ?? '') + delta.text;
          yield { type: 'text-delta', text: delta.text };
        }
        if (delta?.type === 'input_json_delta' && b?.type === 'server_tool_use') {
          const pj =
            typeof delta.partial_json === 'string' ? delta.partial_json : '';
          b._partialJson = String(b._partialJson ?? '') + pj;
        }
      }

      if (t === 'content_block_stop') {
        const idx = d.index as number;
        const b = acc.blocks[idx];
        if (b?.type === 'server_tool_use' && typeof b._partialJson === 'string') {
          try {
            b.input = JSON.parse(b._partialJson);
          } catch {
            b.input = {};
          }
          delete b._partialJson;
        }
      }

      if (t === 'message_delta') {
        const delta = d.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.stop_reason === 'string') {
          acc.stopReason = delta.stop_reason;
        }
      }

      if (t === 'error') {
        const errObj = d.error as Record<string, unknown> | undefined;
        throw new Error(
          `Anthropic stream error: ${String(errObj?.type ?? 'error')} ${String(errObj?.message ?? JSON.stringify(d))}`,
        );
      }
    }
  }

  async generateText(params: ClaudeGenerateTextParams): Promise<string> {
    const apiKey = this.configService.get<string>('CLAUDE_API_KEY');
    if (!apiKey) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    const {
      prompt,
      system,
      maxTokens: maxTokensParam = 1024,
      temperature = 0.2,
      messages = [],
    } = params;

    const historyMessages: ApiMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const conversationMessages: ApiMessage[] = [
      ...historyMessages,
      { role: 'user', content: prompt },
    ];

    let useServerTools = true;
    for (let toolRetry = 0; toolRetry < 2; toolRetry++) {
      const tools = useServerTools ? this.buildServerTools() : undefined;
      const max_tokens = tools
        ? Math.max(maxTokensParam, 4096)
        : maxTokensParam;

      for (
        let attempt = 1;
        attempt <= ClaudeAiService.MAX_ATTEMPTS;
        attempt++
      ) {
        try {
          return await this.runMessagesWithPauseTurns(
            apiKey,
            {
              model: this.getModel(),
              max_tokens,
              temperature,
              system,
              tools,
            },
            conversationMessages,
          );
        } catch (error: unknown) {
          if (
            toolRetry === 0 &&
            useServerTools &&
            isServerToolRejectedError(error)
          ) {
            this.logger.warn(
              'Anthropic server tools rejected (enable Web search & Web fetch in Claude Console, or set CLAUDE_WEB_SEARCH_ENABLED=false / CLAUDE_WEB_FETCH_ENABLED=false). Retrying without native web tools.',
            );
            useServerTools = false;
            break;
          }

          const summary = summarizeClaudeHttpError(error);
          const retriable =
            attempt < ClaudeAiService.MAX_ATTEMPTS &&
            isTransientClaudeNetworkError(error);
          if (retriable) {
            this.logger.warn(
              `Claude request attempt ${attempt}/${ClaudeAiService.MAX_ATTEMPTS} failed (${summary}), retrying…`,
            );
            await delay(400 * attempt);
            continue;
          }
          this.logger.error(`Claude request failed: ${summary}`);
          throw error;
        }
      }
    }
    throw new Error('Claude: retry loop exited without result');
  }

  private async runMessagesWithPauseTurns(
    apiKey: string,
    base: {
      model: string;
      max_tokens: number;
      temperature: number;
      system?: string;
      tools?: Record<string, unknown>[];
    },
    conversationMessages: ApiMessage[],
  ): Promise<string> {
    let messages = conversationMessages;
    let lastContent: unknown;
    let stopReason: string | undefined;

    for (
      let round = 0;
      round < ClaudeAiService.MAX_PAUSE_TURN_ROUNDS;
      round++
    ) {
      const payload: Record<string, unknown> = {
        model: base.model,
        max_tokens: base.max_tokens,
        temperature: base.temperature,
        messages,
      };
      if (base.system !== undefined) payload.system = base.system;
      if (base.tools?.length) payload.tools = base.tools;

      const response = await firstValueFrom(
        this.httpService.post(ClaudeAiService.API_URL, payload, {
          timeout: ClaudeAiService.REQUEST_TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        }),
      );

      const data = response.data as {
        content?: unknown;
        stop_reason?: string;
      };
      lastContent = data.content;
      stopReason = data.stop_reason;

      if (stopReason !== 'pause_turn') {
        break;
      }

      messages = [
        ...messages,
        { role: 'assistant', content: data.content as unknown[] },
      ];
      this.logger.debug(
        `Claude pause_turn continuation round ${round + 1}/${ClaudeAiService.MAX_PAUSE_TURN_ROUNDS}`,
      );
    }

    if (stopReason === 'pause_turn') {
      this.logger.warn(
        'Claude stop_reason still pause_turn after max rounds; returning partial text',
      );
    }

    return extractTextFromContentBlocks(lastContent);
  }
}
