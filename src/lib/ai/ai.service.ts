import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { generateText, streamText, stepCountIs } from 'ai';
import { createGateway } from '@ai-sdk/gateway';

import { systemPrompt as SYSTEM_PROMPT } from './sp';
import { createDbTool } from './tools/db.tool';
import { createMediaTool } from './tools/media.tool';
import { webSearch } from '@valyu/ai-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ClaudeAiService } from '../claude-ai/claude-ai.service';

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

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly gateway;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly claudeAiService: ClaudeAiService,
  ) {
    this.gateway = createGateway({
      apiKey: this.configService.get<string>('AI_GATEWAY_API_KEY'),
    });
    this.logger.log(`AI model activated: ${this.getModel()}`);
  }

  private getTools() {
    const model = this.gateway(this.getModel());
    const tools: Record<string, any> = {
      database: createDbTool(this.prisma),
      media: createMediaTool(model),
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

  async generateClaudeResponseWithHistory(
    messages: ChatMessage[],
  ): Promise<string> {
    if (!this.claudeAiService.isConfigured()) {
      throw new Error('Claude fallback is not configured');
    }

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

    return this.claudeAiService.generateText({
      prompt: lastUserMessage.content,
      system: SYSTEM_PROMPT,
      messages: this.buildClaudeMessages(history),
    });
  }

  async generateResponse(userPrompt: string): Promise<string> {
    return this.generateResponseWithHistory([
      { role: 'user', content: userPrompt },
    ]);
  }

  async generateResponseWithHistory(messages: ChatMessage[]): Promise<string> {
    try {
      const model = this.getModel();
      this.logger.log(`Using model: ${model}`);

      const result = await generateText({
        model: this.gateway(model),
        system: SYSTEM_PROMPT,
        messages: this.buildSdkMessages(messages),
        tools: this.getTools(),
        stopWhen: stepCountIs(5),
      });

      return result.text;
    } catch (error: unknown) {
      this.logger.error('AI Gateway error', error);
      if (this.claudeAiService.isConfigured()) {
        this.logger.warn('Falling back to Claude for text generation');
        return this.generateClaudeResponseWithHistory(messages);
      }
      throw error;
    }
  }

  streamResponseWithHistory(messages: ChatMessage[]): {
    fullStream: AsyncIterable<any>;
  } {
    const model = this.getModel();
    this.logger.log(`Using model: ${model}`);

    const result = streamText({
      model: this.gateway(model),
      system: SYSTEM_PROMPT,
      messages: this.buildSdkMessages(messages),
      tools: this.getTools(),
      stopWhen: stepCountIs(5),
    });

    return { fullStream: result.fullStream };
  }
}
