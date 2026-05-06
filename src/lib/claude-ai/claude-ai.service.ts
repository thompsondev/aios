import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type ClaudeGenerateTextParams = {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  messages?: ClaudeMessage[];
};

@Injectable()
export class ClaudeAiService {
  private readonly logger = new Logger(ClaudeAiService.name);
  private static readonly DEFAULT_MODEL = 'claude-3-5-sonnet-latest';
  private static readonly API_URL = 'https://api.anthropic.com/v1/messages';

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

  async generateText(params: ClaudeGenerateTextParams): Promise<string> {
    const apiKey = this.configService.get<string>('CLAUDE_API_KEY');
    if (!apiKey) {
      throw new Error('CLAUDE_API_KEY is not configured');
    }

    const {
      prompt,
      system,
      maxTokens = 1024,
      temperature = 0.2,
      messages = [],
    } = params;
    const finalMessages: ClaudeMessage[] = [
      ...messages,
      { role: 'user', content: prompt },
    ];

    const payload = {
      model: this.getModel(),
      max_tokens: maxTokens,
      temperature,
      system,
      messages: finalMessages,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(ClaudeAiService.API_URL, payload, {
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        }),
      );

      const content = response.data?.content;
      if (!Array.isArray(content)) return '';

      const text = content
        .filter(
          (item: { type?: string; text?: string }) => item?.type === 'text',
        )
        .map((item: { text?: string }) => item.text ?? '')
        .join('');

      return text;
    } catch (error: unknown) {
      this.logger.error('Claude request failed', String(error));
      throw error;
    }
  }
}
