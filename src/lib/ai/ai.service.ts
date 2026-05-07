import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { generateText, streamText, stepCountIs } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { Agent, fetch as undiciFetch } from 'undici';

import { systemPrompt as SYSTEM_PROMPT } from './sp';
import { createDbTool } from './tools/db.tool';
import { createMediaTool } from './tools/media.tool';
import { webSearch } from '@valyu/ai-sdk';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClaudeAiService,
  summarizeClaudeHttpError,
} from '../claude-ai/claude-ai.service';

const DEFAULT_AI_MODEL = 'openai/gpt-4o';

export type Attachment = {
  name: string;
  mimeType: string;
  /** base64-encoded file data */
  data: string;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
};

export type AiProvider = 'claude' | 'gateway';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly gateway;
  private readonly gatewayModel;
  private readonly gatewayConnectTimeoutMs: number;
  private readonly gatewayStreamRetryCount: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly claudeAiService: ClaudeAiService,
  ) {
    this.gatewayConnectTimeoutMs = this.parsePositiveInt(
      this.configService.get<string>('AI_GATEWAY_CONNECT_TIMEOUT_MS'),
      30_000,
    );
    this.gatewayStreamRetryCount = this.parsePositiveInt(
      this.configService.get<string>('AI_GATEWAY_STREAM_RETRIES'),
      2,
    );
    const gatewayAgent = new Agent({
      connectTimeout: this.gatewayConnectTimeoutMs,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
    });
    this.gateway = createGateway({
      apiKey: this.configService.get<string>('AI_GATEWAY_API_KEY'),
      fetch: (input, init) =>
        undiciFetch(input as any, {
          ...(init ?? {}),
          dispatcher: gatewayAgent,
        } as any),
    });
    this.gatewayModel = this.gateway(this.getModel());
    this.logger.log(`AI model activated: ${this.getModel()}`);
    this.logger.log(
      `AI Gateway connect timeout: ${this.gatewayConnectTimeoutMs}ms`,
    );
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private isConnectivityIssueMessage(msg: string): boolean {
    const m = msg.toLowerCase();
    return (
      m.includes('enotfound') ||
      m.includes('getaddrinfo') ||
      m.includes('eai_again') ||
      m.includes('und_err_connect_timeout') ||
      m.includes('connect timeout') ||
      m.includes('request timed out') ||
      m.includes('socket hang up') ||
      m.includes('network error')
    );
  }

  private connectivityErrorMessageFrom(msg: string): string {
    const m = msg.toLowerCase();
    if (m.includes('enotfound') || m.includes('getaddrinfo')) {
      return 'No internet connection or DNS resolution failed. Please check your network and try again.';
    }
    if (
      m.includes('connect timeout') ||
      m.includes('request timed out') ||
      m.includes('und_err_connect_timeout')
    ) {
      return 'Internet connection is unstable/slow right now (connection timeout). Please retry in a moment.';
    }
    if (m.includes('socket hang up')) {
      return 'Internet connection dropped while contacting AI providers. Please retry.';
    }
    return 'Network connection issue while contacting AI providers. Please check internet and retry.';
  }

  private getTools() {
    const tools: Record<string, any> = {
      database: createDbTool(this.prisma),
      media: createMediaTool(this.gatewayModel),
    };
    if (this.isWebSearchEnabled()) {
      tools.webSearch = webSearch({ maxNumResults: 5, fastMode: true });
    }
    return tools;
  }

  private getModel(): string {
    const env = this.configService.get<string>('AI_MODEL')?.trim();
    return env && env.length > 0 ? env : DEFAULT_AI_MODEL;
  }

  isWebSearchEnabled(): boolean {
    return !!this.configService.get<string>('VALYU_API_KEY');
  }

  isClaudeConfigured(): boolean {
    return this.claudeAiService.isConfigured();
  }

  /** Searches the web and returns formatted context, or null if not configured / failed. */
  async searchWeb(query: string): Promise<string | null> {
    if (!this.isWebSearchEnabled()) return null;

    try {
      const tool = webSearch({ maxNumResults: 5, fastMode: true });
      const results: any = await (tool as any).execute(
        { query },
        { toolCallId: 'pre-search', messages: [] },
      );

      if (!results?.results?.length) return null;

      const formatted = (results.results as any[])
        .slice(0, 5)
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content ?? '').slice(0, 800)}`,
        )
        .join('\n\n');

      return `<web_search_results>\nQuery: ${query}\n\n${formatted}\n</web_search_results>`;
    } catch (err: any) {
      this.logger.warn(
        'Web search failed, continuing without context',
        err?.message,
      );
      return null;
    }
  }

  private buildSdkMessages(messages: ChatMessage[]): any[] {
    return messages.map((msg) => {
      if (
        msg.role === 'user' &&
        msg.attachments &&
        msg.attachments.length > 0
      ) {
        const parts: any[] = [];
        for (const att of msg.attachments) {
          const bytes = Buffer.from(att.data, 'base64');
          if (att.mimeType.startsWith('image/')) {
            parts.push({
              type: 'image',
              image: new Uint8Array(bytes),
              mimeType: att.mimeType,
            });
          } else {
            parts.push({
              type: 'file',
              data: new Uint8Array(bytes),
              mediaType: att.mimeType,
            });
          }
        }
        if (msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }
        return { role: 'user', content: parts };
      }
      return { role: msg.role, content: msg.content };
    });
  }

  private buildClaudeMessages(messages: ChatMessage[]): Array<{
    role: 'user' | 'assistant';
    content: string;
  }> {
    return messages.map((msg) => {
      if (msg.role === 'user' && msg.attachments?.length) {
        return {
          role: 'user',
          content: `${msg.content}\n\n[User attached ${msg.attachments.length} file(s). Claude fallback currently handles text only.]`,
        };
      }
      return { role: msg.role, content: msg.content };
    });
  }

  private buildClaudeRequestParams(messages: ChatMessage[]): {
    prompt: string;
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens: number;
    temperature: number;
  } {
    const history = messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === 'user');

    if (!lastUserMessage) {
      throw new Error('No user message found for Claude request');
    }

    return {
      prompt: lastUserMessage.content,
      system: SYSTEM_PROMPT,
      messages: this.buildClaudeMessages(history),
      maxTokens: 8192,
      temperature: 0.2,
    };
  }

  async generateClaudeResponseWithHistory(
    messages: ChatMessage[],
  ): Promise<string> {
    if (!this.claudeAiService.isConfigured()) {
      throw new Error('Claude fallback is not configured');
    }

    const p = this.buildClaudeRequestParams(messages);
    return this.claudeAiService.generateText({
      prompt: p.prompt,
      system: p.system,
      messages: p.messages,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
    });
  }

  async generateResponse(userPrompt: string): Promise<string> {
    return this.generateResponseWithHistory([
      { role: 'user', content: userPrompt },
    ]);
  }

  async generateResponseWithHistoryAndProvider(
    messages: ChatMessage[],
  ): Promise<{
    text: string;
    provider: AiProvider;
  }> {
    // Primary: Anthropic Messages API. Fallback: AI Gateway (OpenAI-compatible models + tools).
    if (this.claudeAiService.isConfigured()) {
      try {
        this.logger.log(
          `[chat] Primary: Claude (${this.claudeAiService.getModel()})`,
        );
        const text = await this.generateClaudeResponseWithHistory(messages);
        if (text?.trim()) {
          return { text, provider: 'claude' };
        }
        this.logger.warn(
          '[chat] Claude returned empty output; falling back to AI Gateway',
        );
      } catch (claudeError: unknown) {
        this.logger.error(
          `[chat] Claude failed; fallback to AI Gateway: ${summarizeClaudeHttpError(claudeError)}`,
        );
      }
    } else {
      this.logger.log('[chat] Claude not configured; using AI Gateway only');
    }

    const model = this.getModel();
    this.logger.log(`[chat] AI Gateway model: ${model}`);
    const result = await generateText({
      model: this.gatewayModel,
      system: SYSTEM_PROMPT,
      messages: this.buildSdkMessages(messages),
      tools: this.getTools(),
      stopWhen: stepCountIs(5),
    });
    return { text: result.text, provider: 'gateway' };
  }

  async generateResponseWithHistory(messages: ChatMessage[]): Promise<string> {
    try {
      const { text } =
        await this.generateResponseWithHistoryAndProvider(messages);
      return text;
    } catch (error: unknown) {
      this.logger.error('AI text generation error', error);
      throw error;
    }
  }

  private async *streamGateway(messages: ChatMessage[]): AsyncIterable<any> {
    const model = this.getModel();
    for (let attempt = 1; attempt <= this.gatewayStreamRetryCount; attempt++) {
      try {
        if (attempt > 1) {
          this.logger.warn(
            `[chat stream] Retrying AI Gateway stream (${attempt}/${this.gatewayStreamRetryCount})`,
          );
        }
        const gatewayResult = streamText({
          model: this.gatewayModel,
          system: SYSTEM_PROMPT,
          messages: this.buildSdkMessages(messages),
          tools: this.getTools(),
          stopWhen: stepCountIs(5),
        });
        for await (const part of gatewayResult.fullStream) {
          yield part;
        }
        return;
      } catch (err: unknown) {
        const msg = String((err as any)?.message ?? err);
        const connectivityLike = this.isConnectivityIssueMessage(msg);
        if (!connectivityLike || attempt >= this.gatewayStreamRetryCount) {
          if (connectivityLike) {
            throw new Error(this.connectivityErrorMessageFrom(msg));
          }
          throw err;
        }
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  /**
   * Streaming chat: try Claude first (Anthropic native web_search / web_fetch when enabled in Console + env).
   * On failure or empty body, stream from AI Gateway (Valyu webSearch + tools).
   */
  private async *streamClaudeFirst(
    messages: ChatMessage[],
    actualProviderRef: { current: AiProvider },
  ): AsyncIterable<any> {
    try {
      this.logger.log(
        `[chat stream] Primary: Claude (${this.claudeAiService.getModel()})`,
      );
      if (this.claudeAiService.isStreamingEnabled()) {
        const params = this.buildClaudeRequestParams(messages);
        if (this.claudeAiService.shouldForceValidatedImageResponse(params.prompt)) {
          const text = await this.generateClaudeResponseWithHistory(messages);
          if (text?.trim()) {
            actualProviderRef.current = 'claude';
            yield { type: 'text-delta', text };
            yield { type: 'finish', finishReason: 'stop' };
            return;
          }
        }
        let sawText = false;
        for await (const part of this.claudeAiService.streamGenerateText({
          prompt: params.prompt,
          system: params.system,
          messages: params.messages,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
        })) {
          if (part.type === 'text-delta' && part.text) {
            sawText = true;
          }
          yield part;
        }
        if (sawText) {
          actualProviderRef.current = 'claude';
          yield { type: 'finish', finishReason: 'stop' };
          return;
        }
        this.logger.warn(
          '[chat stream] Claude stream produced no text; falling back to AI Gateway',
        );
      } else {
        const surfaceNativeWebUi = this.claudeAiService.shouldSurfaceWebToolUi();
        if (surfaceNativeWebUi) {
          yield { type: 'tool-call', toolName: 'webSearch' };
        }
        const text = await this.generateClaudeResponseWithHistory(messages);
        if (surfaceNativeWebUi) {
          yield { type: 'tool-result', toolName: 'webSearch' };
        }
        if (text?.trim()) {
          actualProviderRef.current = 'claude';
          yield { type: 'text-delta', text };
          yield { type: 'finish', finishReason: 'stop' };
          return;
        }
        this.logger.warn(
          '[chat stream] Claude returned empty output; falling back to AI Gateway',
        );
      }
    } catch (claudeError: unknown) {
      this.logger.error(
        `[chat stream] Claude failed; fallback to AI Gateway: ${summarizeClaudeHttpError(claudeError)}`,
      );
    }

    actualProviderRef.current = 'gateway';
    const model = this.getModel();
    this.logger.log(`[chat stream] AI Gateway model: ${model}`);
    yield* this.streamGateway(messages);
  }

  streamResponseWithHistory(messages: ChatMessage[]): {
    fullStream: AsyncIterable<any>;
    /** Preferred provider when Claude key exists (for headers); see actualProviderRef for what served the reply. */
    provider: AiProvider;
    actualProviderRef: { current: AiProvider };
  } {
    const actualProviderRef: { current: AiProvider } = { current: 'gateway' };

    if (this.claudeAiService.isConfigured()) {
      actualProviderRef.current = 'claude';
      return {
        fullStream: this.streamClaudeFirst(messages, actualProviderRef),
        provider: 'claude',
        actualProviderRef,
      };
    }

    this.logger.log('[chat stream] Claude not configured; using AI Gateway only');
    const model = this.getModel();
    this.logger.log(`[chat stream] AI Gateway model: ${model}`);

    const result = streamText({
      model: this.gatewayModel,
      system: SYSTEM_PROMPT,
      messages: this.buildSdkMessages(messages),
      tools: this.getTools(),
      stopWhen: stepCountIs(5),
    });

    return {
      fullStream: result.fullStream,
      provider: 'gateway',
      actualProviderRef,
    };
  }
}
