import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeDbToolService } from './claude-db-tool.service';

type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string;
};

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
  /** When false, no web_search / web_fetch tools (saves tokens; use for enrichment). Default true. */
  enableServerTools?: boolean;
  /** When true, skip post-hoc image URL validation (extra calls). Use for non-chat JSON tasks. */
  skipImagePostValidation?: boolean;
  /** When false, omit Prisma database_read/database_write tools. Default true if tools are enabled in env. */
  enableDatabaseTools?: boolean;
};

/** Parts compatible with AI SDK stream shape used in ChatService. */
export type ClaudeStreamYield =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string }
  | { type: 'tool-result'; toolName: string };

/** Safe log line for Anthropic errors ? never includes API key or request config. */
export function summarizeClaudeHttpError(error: unknown): string {
  const e = error as {
    status?: number;
    code?: string;
    error?: { type?: string; message?: string };
    message?: string;
  };
  if (e.error?.message) {
    return `HTTP ${e.status ?? '?'} ${e.error.type ?? 'error'}: ${e.error.message}`;
  }
  if (e.code) {
    return `${e.code}${e.message ? `: ${e.message}` : ''}`;
  }
  if (e.message) return e.message;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isClaudeRateLimitError(error: unknown): boolean {
  const e = error as {
    status?: number;
    type?: string;
    error?: { type?: string; error?: { type?: string } };
  };
  if (e.status === 429) return true;
  if (e.type === 'rate_limit_error') return true;
  const inner = e.error?.error?.type ?? (e.error as { type?: string } | undefined)?.type;
  return inner === 'rate_limit_error';
}

/** Wait time from Anthropic headers, or a conservative default. */
function getClaudeRateLimitWaitMs(error: unknown): number {
  const e = error as { headers?: Headers };
  const h = e.headers;
  if (h && typeof h.get === 'function') {
    const reset = h.get('anthropic-ratelimit-input-tokens-reset');
    if (reset) {
      const ms = Date.parse(reset) - Date.now();
      if (Number.isFinite(ms) && ms > 0) {
        return Math.min(ms + 1_000, 180_000);
      }
    }
    const ra = h.get('retry-after');
    if (ra) {
      const sec = Number.parseInt(ra, 10);
      if (Number.isFinite(sec) && sec > 0) {
        return Math.min(sec * 1_000 + 500, 120_000);
      }
    }
  }
  return 15_000;
}

function isTransientClaudeNetworkError(error: unknown): boolean {
  const e = error as { status?: number; code?: string; message?: string };
  const status = e.status;
  if (status === 502 || status === 503 || status === 504) return true;
  if (status != null && status < 500) return false;

  const code = e.code;
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EPIPE'
  ) {
    return true;
  }

  const msg = (e.message || '').toLowerCase();
  return (
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('request timed out') ||
    msg.includes('connect timeout') ||
    (msg.includes('timeout') && msg.includes('fetch'))
  );
}

/** Anthropic returned 400 ? org may not have server tools enabled in Console. */
function isServerToolRejectedError(error: unknown): boolean {
  const e = error as {
    status?: number;
    error?: { message?: string };
    message?: string;
  };
  if (e.status !== 400) return false;
  const msg = (e.error?.message || e.message || '').toLowerCase();
  return (
    msg.includes('tool') ||
    msg.includes('web_search') ||
    msg.includes('web fetch') ||
    msg.includes('server tool')
  );
}

function extractTextFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out.join('');
}

function extractToolUseBlocks(
  content: unknown,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: Record<string, unknown> }> =
    [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as {
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    if (b.type === 'tool_use' && b.id && b.name) {
      out.push({
        id: b.id,
        name: b.name,
        input:
          b.input && typeof b.input === 'object' && !Array.isArray(b.input)
            ? (b.input as Record<string, unknown>)
            : {},
      });
    }
  }
  return out;
}

function extractCandidateImageUrls(text: string): string[] {
  const urls = new Set<string>();

  // Markdown images: ![alt](https://...)
  for (const m of text.matchAll(/!\[[^\]]*?\]\((https?:\/\/[^)\s]+)\)/gi)) {
    if (m[1]) urls.add(m[1].trim());
  }

  // "Image URL: https://..."
  for (const m of text.matchAll(/image\s*url\s*:\s*(https?:\/\/\S+)/gi)) {
    if (m[1]) urls.add(m[1].replace(/[),.;]+$/, '').trim());
  }

  // Direct image-looking URLs anywhere
  for (const m of text.matchAll(/https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif)(?:\?\S*)?/gi)) {
    if (m[0]) urls.add(m[0].replace(/[),.;]+$/, '').trim());
  }

  return Array.from(urls);
}

function extractDeclaredImageUrlLines(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(/image\s*url\s*:\s*([^\n\r]+)/gi)) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    const fromLink = raw.match(/\((https?:\/\/[^)\s]+)\)/i)?.[1];
    const fromTicks = raw.match(/`(https?:\/\/[^`\s]+)`/i)?.[1];
    const direct = raw.match(/(https?:\/\/\S+)/i)?.[1];
    const u = (fromLink || fromTicks || direct || '').replace(/[),.;]+$/, '');
    if (u) urls.push(u);
  }
  return urls;
}

function isImageRequestPrompt(prompt: string): boolean {
  return /\b(image|photo|picture|thumbnail|img|image\s*url)\b/i.test(prompt);
}

function isLikelyProductLookupPrompt(prompt: string): boolean {
  const hasMpnLikeCode = /\b[A-Z0-9]{5,}(?:[-\/][A-Z0-9]{2,})+\b/i.test(prompt);
  const hasProductTerms =
    /\b(mpn|sku|model|part\s*number|specs?|specification|device)\b/i.test(
      prompt,
    );
  return hasMpnLikeCode || hasProductTerms;
}

@Injectable()
export class ClaudeAiService {
  private readonly logger = new Logger(ClaudeAiService.name);
  private readonly client: Anthropic;

  /** Current Claude Sonnet on Messages API. */
  private static readonly DEFAULT_MODEL = 'claude-sonnet-4-6';
  private static readonly REQUEST_TIMEOUT_MS = 600_000;
  private static readonly MAX_ATTEMPTS = 3;
  private static readonly MAX_PAUSE_TURN_ROUNDS = 16;
  private static readonly MAX_TOOL_AND_PAUSE_STEPS = 32;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly dbToolService?: ClaudeDbToolService,
  ) {
    this.client = new Anthropic({
      apiKey: this.configService.get<string>('CLAUDE_API_KEY') ?? undefined,
      timeout: ClaudeAiService.REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  isConfigured(): boolean {
    return !!this.configService.get<string>('CLAUDE_API_KEY');
  }

  getModel(): string {
    const model = this.configService.get<string>('CLAUDE_MODEL')?.trim();
    return model && model.length > 0 ? model : ClaudeAiService.DEFAULT_MODEL;
  }

  isStreamingEnabled(): boolean {
    return (
      (this.configService.get<string>('CLAUDE_STREAMING_ENABLED') ?? 'true')
        .trim()
        .toLowerCase() !== 'false'
    );
  }

  shouldSurfaceWebToolUi(): boolean {
    const tools = this.buildServerTools();
    return tools != null && tools.length > 0;
  }

  shouldForceValidatedImageResponse(prompt: string): boolean {
    return (
      this.isImageUrlValidationEnabled() &&
      (isImageRequestPrompt(prompt) || isLikelyProductLookupPrompt(prompt))
    );
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private isImageUrlValidationEnabled(): boolean {
    return (
      (this.configService.get<string>('CLAUDE_VALIDATE_IMAGE_URLS') ?? 'true')
        .trim()
        .toLowerCase() !== 'false'
    );
  }

  private async isWorkingImageUrl(url: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      return ct.startsWith('image/');
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async hasValidImageUrls(text: string): Promise<boolean> {
    const urls = extractCandidateImageUrls(text);
    if (urls.length === 0) return false;
    for (const u of urls) {
      if (await this.isWorkingImageUrl(u)) return true;
    }
    return false;
  }

  private async validateImageUrls(text: string): Promise<{
    valid: string[];
    invalid: string[];
  }> {
    const urls = extractCandidateImageUrls(text);
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const u of urls) {
      if (await this.isWorkingImageUrl(u)) valid.push(u);
      else invalid.push(u);
    }
    return { valid, invalid };
  }

  private async validateDeclaredSingleImageUrl(text: string): Promise<{
    ok: boolean;
    declared: string[];
    validDeclared: string[];
  }> {
    const declared = extractDeclaredImageUrlLines(text);
    const validDeclared: string[] = [];
    for (const u of declared) {
      if (await this.isWorkingImageUrl(u)) validDeclared.push(u);
    }
    const ok = declared.length === 1 && validDeclared.length === 1;
    return { ok, declared, validDeclared };
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

  private buildServerTools(): Array<Record<string, unknown>> | undefined {
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
    const tools: Array<Record<string, unknown>> = [];

    if (searchOn) {
      const t: Record<string, unknown> = {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: this.parsePositiveInt(
          this.configService.get<string>('CLAUDE_WEB_SEARCH_MAX_USES'),
          10,
        ),
      };
      if (domains?.length) t.allowed_domains = domains;
      tools.push(t);
    }

    if (fetchOn) {
      const t: Record<string, unknown> = {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: this.parsePositiveInt(
          this.configService.get<string>('CLAUDE_WEB_FETCH_MAX_USES'),
          5,
        ),
      };
      if (domains?.length) t.allowed_domains = domains;
      tools.push(t);
    }

    return tools.length ? tools : undefined;
  }

  private composeTools(
    useServerTools: boolean,
    enableDatabaseTools: boolean,
  ): Array<Record<string, unknown>> | undefined {
    const out: Array<Record<string, unknown>> = [];
    if (enableDatabaseTools && this.dbToolService?.isEnabled()) {
      out.push(...this.dbToolService.getAnthropicToolDefinitions());
    }
    if (useServerTools) {
      const st = this.buildServerTools();
      if (st?.length) out.push(...st);
    }
    return out.length ? out : undefined;
  }

  private async runClientTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    if (!this.dbToolService?.isEnabled()) {
      return JSON.stringify({
        ok: false,
        error: 'Database tools are not enabled (CLAUDE_DB_TOOLS_ENABLED)',
      });
    }
    return this.dbToolService.executeTool(name, input);
  }

  private toConversation(params: ClaudeGenerateTextParams): ApiMessage[] {
    const historyMessages: ApiMessage[] = (params.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    return [...historyMessages, { role: 'user', content: params.prompt }];
  }

  async generateText(params: ClaudeGenerateTextParams): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    let useServerTools = params.enableServerTools !== false;
    const enableDatabaseTools = params.enableDatabaseTools !== false;
    const conversation = this.toConversation(params);

    for (let toolRetry = 0; toolRetry < 2; toolRetry++) {
      const tools = this.composeTools(useServerTools, enableDatabaseTools);
      const max_tokens =
        tools && tools.length > 0
          ? Math.max(params.maxTokens ?? 1024, 4096)
          : (params.maxTokens ?? 1024);

      for (
        let attempt = 1;
        attempt <= ClaudeAiService.MAX_ATTEMPTS;
        attempt++
      ) {
        try {
          let text = await this.runCreateWithPauseTurns({
            model: this.getModel(),
            system: params.system,
            temperature: params.temperature ?? 0.2,
            max_tokens,
            tools,
            messages: conversation,
          });
          if (params.skipImagePostValidation) {
            return text;
          }
          if (!this.isImageUrlValidationEnabled()) {
            return text;
          }

          const strictImageValidation =
            isImageRequestPrompt(params.prompt) ||
            isLikelyProductLookupPrompt(params.prompt);
          const firstValidation = await this.validateImageUrls(text);
          if (!strictImageValidation) {
            return text;
          }

          const declaredFirst = await this.validateDeclaredSingleImageUrl(text);
          if (
            declaredFirst.ok &&
            firstValidation.valid.length > 0 &&
            firstValidation.invalid.length === 0
          ) {
            return text;
          }

          let repairMessages: ApiMessage[] = [
            ...conversation,
            { role: 'assistant', content: text },
          ];
          for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt++) {
            repairMessages = [
              ...repairMessages,
              {
                role: 'user',
                content:
                  'The image URL(s) you provided did not meet output rules. Search again using different reliable sources and return exactly ONE working direct HTTPS image URL. Requirements: (1) include one markdown image, (2) include exactly one "Image URL:" line, (3) that URL must load as an image, (4) do not include additional image URLs.',
              },
            ];
            text = await this.runCreateWithPauseTurns({
              model: this.getModel(),
              system: params.system,
              temperature: params.temperature ?? 0.2,
              max_tokens,
              tools,
              messages: repairMessages,
            });
            const v = await this.validateImageUrls(text);
            const declared = await this.validateDeclaredSingleImageUrl(text);
            if (declared.ok && v.valid.length > 0 && v.invalid.length === 0) {
              return text;
            }
            repairMessages = [...repairMessages, { role: 'assistant', content: text }];
          }

          // Return best effort even when validation keeps failing.
          return text;
        } catch (error: unknown) {
          if (
            toolRetry === 0 &&
            useServerTools &&
            isServerToolRejectedError(error)
          ) {
            this.logger.warn(
              'Anthropic server tools rejected; retrying without native web tools.',
            );
            useServerTools = false;
            break;
          }

          const summary = summarizeClaudeHttpError(error);
          if (
            isClaudeRateLimitError(error) &&
            attempt < ClaudeAiService.MAX_ATTEMPTS
          ) {
            const waitMs = getClaudeRateLimitWaitMs(error);
            this.logger.warn(
              `Claude rate limited; waiting ${waitMs}ms before retry ${attempt + 1}/${ClaudeAiService.MAX_ATTEMPTS}`,
            );
            await delay(waitMs);
            continue;
          }
          const retriable =
            attempt < ClaudeAiService.MAX_ATTEMPTS &&
            isTransientClaudeNetworkError(error);
          if (retriable) {
            this.logger.warn(
              `Claude request attempt ${attempt}/${ClaudeAiService.MAX_ATTEMPTS} failed (${summary}), retrying?`,
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

  async *streamGenerateText(
    params: ClaudeGenerateTextParams,
  ): AsyncGenerator<ClaudeStreamYield> {
    if (!this.isConfigured()) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    let useServerTools = params.enableServerTools !== false;
    const enableDatabaseTools = params.enableDatabaseTools !== false;
    const initialConversation = this.toConversation(params);

    for (let toolRetry = 0; toolRetry < 2; toolRetry++) {
      const tools = this.composeTools(useServerTools, enableDatabaseTools);
      const max_tokens =
        tools && tools.length > 0
          ? Math.max(params.maxTokens ?? 1024, 4096)
          : (params.maxTokens ?? 1024);

      for (
        let attempt = 1;
        attempt <= ClaudeAiService.MAX_ATTEMPTS;
        attempt++
      ) {
        try {
          let conversation = initialConversation;

          for (
            let round = 0;
            round < ClaudeAiService.MAX_PAUSE_TURN_ROUNDS;
            round++
          ) {
            const stream = this.client.messages.stream({
              model: this.getModel(),
              system: params.system,
              temperature: params.temperature ?? 0.2,
              max_tokens,
              messages: conversation as any,
              tools: tools as any,
            });

            for await (const event of stream as AsyncIterable<any>) {
              if (event?.type === 'content_block_delta') {
                const delta = event.delta;
                if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                  yield { type: 'text-delta', text: delta.text };
                }
              }

              if (event?.type === 'content_block_start') {
                const block = event.content_block;
                if (block?.type === 'server_tool_use') {
                  const name = block.name as string;
                  if (name === 'web_search') {
                    yield { type: 'tool-call', toolName: 'claude:web_search' };
                  } else if (name === 'web_fetch') {
                    yield { type: 'tool-call', toolName: 'claude:web_fetch' };
                  }
                } else if (block?.type === 'tool_use') {
                  const name = block.name as string;
                  if (name) {
                    yield { type: 'tool-call', toolName: name };
                  }
                }
                if (block?.type === 'web_search_tool_result') {
                  yield { type: 'tool-result', toolName: 'claude:web_search' };
                } else if (block?.type === 'web_fetch_tool_result') {
                  yield { type: 'tool-result', toolName: 'claude:web_fetch' };
                }
              }
            }

            const message = await stream.finalMessage();

            if (message.stop_reason === 'tool_use') {
              const toolUses = extractToolUseBlocks(message.content);
              const resultBlocks: unknown[] = [];
              for (const tu of toolUses) {
                const payload = await this.runClientTool(tu.name, tu.input);
                resultBlocks.push({
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  content: payload,
                });
                yield { type: 'tool-result', toolName: tu.name };
              }
              conversation = [
                ...conversation,
                { role: 'assistant', content: message.content as unknown[] },
                { role: 'user', content: resultBlocks },
              ];
              continue;
            }

            if (message.stop_reason !== 'pause_turn') {
              return;
            }

            conversation = [
              ...conversation,
              { role: 'assistant', content: message.content as unknown[] },
            ];
            this.logger.debug(
              `Claude streaming pause_turn ${round + 1}/${ClaudeAiService.MAX_PAUSE_TURN_ROUNDS}`,
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
          if (
            isClaudeRateLimitError(error) &&
            attempt < ClaudeAiService.MAX_ATTEMPTS
          ) {
            const waitMs = getClaudeRateLimitWaitMs(error);
            this.logger.warn(
              `Claude streaming rate limited; waiting ${waitMs}ms before retry ${attempt + 1}/${ClaudeAiService.MAX_ATTEMPTS}`,
            );
            await delay(waitMs);
            continue;
          }
          const retriable =
            attempt < ClaudeAiService.MAX_ATTEMPTS &&
            isTransientClaudeNetworkError(error);
          if (retriable) {
            this.logger.warn(
              `Claude streaming attempt ${attempt}/${ClaudeAiService.MAX_ATTEMPTS} failed (${summary}), retrying?`,
            );
            await delay(400 * attempt);
            continue;
          }
          throw error;
        }
      }
    }
  }

  private async runCreateWithPauseTurns(params: {
    model: string;
    system?: string;
    temperature: number;
    max_tokens: number;
    tools?: Array<Record<string, unknown>>;
    messages: ApiMessage[];
  }): Promise<string> {
    let conversation = params.messages;
    let lastText = '';

    for (let step = 0; step < ClaudeAiService.MAX_TOOL_AND_PAUSE_STEPS; step++) {
      const message = await this.client.messages.create({
        model: params.model,
        system: params.system,
        temperature: params.temperature,
        max_tokens: params.max_tokens,
        tools: params.tools as any,
        messages: conversation as any,
      });

      if (message.stop_reason === 'tool_use') {
        const toolUses = extractToolUseBlocks(message.content);
        const resultBlocks: unknown[] = [];
        for (const tu of toolUses) {
          const payload = await this.runClientTool(tu.name, tu.input);
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: payload,
          });
        }
        conversation = [
          ...conversation,
          { role: 'assistant', content: message.content as unknown[] },
          { role: 'user', content: resultBlocks },
        ];
        this.logger.debug(
          `Claude tool_use round; continuing (${step + 1}/${ClaudeAiService.MAX_TOOL_AND_PAUSE_STEPS})`,
        );
        continue;
      }

      lastText = extractTextFromContentBlocks(message.content);
      if (message.stop_reason !== 'pause_turn') {
        return lastText;
      }

      conversation = [
        ...conversation,
        { role: 'assistant', content: message.content as unknown[] },
      ];
      this.logger.debug(
        `Claude pause_turn continuation step ${step + 1}/${ClaudeAiService.MAX_TOOL_AND_PAUSE_STEPS}`,
      );
    }

    this.logger.warn(
      'Claude stop_reason still pause_turn or tool loop after max steps; returning partial text',
    );
    return lastText;
  }
}
