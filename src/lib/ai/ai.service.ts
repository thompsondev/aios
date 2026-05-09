import { Injectable, Logger } from '@nestjs/common';

import { systemPrompt as SYSTEM_PROMPT } from './sp';
import {
  ClaudeAiService,
  summarizeClaudeHttpError,
} from '../claude-ai/claude-ai.service';

/** Narrow prompt for batch enrichment (avoids sending the full chat system prompt per job). */
const ENRICHMENT_SYSTEM_PROMPT = [
  'You are a catalog data extractor.',
  'Follow the user instructions exactly.',
  'Never invent or infer price fields.',
  'Output only what the user asked for (e.g. JSON).',
].join(' ');

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

export type AiProvider = 'claude';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly claudeAiService: ClaudeAiService) {}

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

  private normalizeProviderError(error: unknown): never {
    const msg = String(
      (error as { message?: string })?.message ??
        summarizeClaudeHttpError(error),
    );
    if (this.isConnectivityIssueMessage(msg)) {
      throw new Error(this.connectivityErrorMessageFrom(msg));
    }
    throw error instanceof Error ? error : new Error(String(error));
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
      throw new Error('CLAUDE_API_KEY is not configured');
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

  /**
   * One-off extraction for enrichment workers: minimal system prompt, no server tools,
   * lower max tokens — reduces TPM vs full chat + web_search.
   */
  async generateEnrichmentExtraction(userPrompt: string): Promise<string> {
    if (!this.claudeAiService.isConfigured()) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }
    try {
      return await this.claudeAiService.generateText({
        prompt: userPrompt,
        system: ENRICHMENT_SYSTEM_PROMPT,
        messages: [],
        maxTokens: 2048,
        temperature: 0.1,
        enableServerTools: false,
        enableDatabaseTools: false,
        skipImagePostValidation: true,
      });
    } catch (error: unknown) {
      this.logger.error(
        `[enrichment] Claude failed: ${summarizeClaudeHttpError(error)}`,
      );
      this.normalizeProviderError(error);
    }
  }

  async generateResponseWithHistoryAndProvider(
    messages: ChatMessage[],
  ): Promise<{
    text: string;
    provider: AiProvider;
  }> {
    if (!this.claudeAiService.isConfigured()) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    try {
      this.logger.log(
        `[chat] Claude (${this.claudeAiService.getModel()})`,
      );
      const text = await this.generateClaudeResponseWithHistory(messages);
      if (!text?.trim()) {
        throw new Error('Claude returned empty output');
      }
      return { text, provider: 'claude' };
    } catch (error: unknown) {
      this.logger.error(
        `[chat] Claude failed: ${summarizeClaudeHttpError(error)}`,
      );
      this.normalizeProviderError(error);
    }
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

  /**
   * Streaming chat: Anthropic only (native web_search / web_fetch when enabled in Console + env).
   */
  private async *streamClaudeOnly(
    messages: ChatMessage[],
  ): AsyncIterable<any> {
    if (!this.claudeAiService.isConfigured()) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    try {
      this.logger.log(
        `[chat stream] Claude (${this.claudeAiService.getModel()})`,
      );
      if (this.claudeAiService.isStreamingEnabled()) {
        const params = this.buildClaudeRequestParams(messages);
        if (this.claudeAiService.shouldForceValidatedImageResponse(params.prompt)) {
          const text = await this.generateClaudeResponseWithHistory(messages);
          if (text?.trim()) {
            yield { type: 'text-delta', text };
            yield { type: 'finish', finishReason: 'stop' };
            return;
          }
          throw new Error('Claude returned no output');
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
          yield { type: 'finish', finishReason: 'stop' };
          return;
        }
        this.logger.warn('[chat stream] Claude stream produced no text');
        throw new Error('Claude returned no output. Please try again.');
      }

      const surfaceNativeWebUi = this.claudeAiService.shouldSurfaceWebToolUi();
      if (surfaceNativeWebUi) {
        yield { type: 'tool-call', toolName: 'webSearch' };
      }
      const text = await this.generateClaudeResponseWithHistory(messages);
      if (surfaceNativeWebUi) {
        yield { type: 'tool-result', toolName: 'webSearch' };
      }
      if (text?.trim()) {
        yield { type: 'text-delta', text };
        yield { type: 'finish', finishReason: 'stop' };
        return;
      }
      throw new Error('Claude returned no output. Please try again.');
    } catch (claudeError: unknown) {
      this.logger.error(
        `[chat stream] Claude failed: ${summarizeClaudeHttpError(claudeError)}`,
      );
      this.normalizeProviderError(claudeError);
    }
  }

  streamResponseWithHistory(messages: ChatMessage[]): {
    fullStream: AsyncIterable<any>;
    provider: AiProvider;
    actualProviderRef: { current: AiProvider };
  } {
    if (!this.claudeAiService.isConfigured()) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    const actualProviderRef: { current: AiProvider } = { current: 'claude' };

    return {
      fullStream: this.streamClaudeOnly(messages),
      provider: 'claude',
      actualProviderRef,
    };
  }

  isClaudeConfigured(): boolean {
    return this.claudeAiService.isConfigured();
  }
}
