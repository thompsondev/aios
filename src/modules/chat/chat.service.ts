import { Injectable, Logger } from '@nestjs/common';
import { AiService, ChatMessage, Attachment } from '../../lib/ai/ai.service';
import { WhatsappService } from '../../lib/whatsapp/wa.service';
import { RedisService } from '../../lib/redis/redis.service';
import { SlackService } from '../../lib/slack/slack.service';

const HISTORY_LIMIT = 20;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SLACK_EVENT_DEDUP_TTL = 300; // 5 minutes

type WhatsAppMessage = {
  type?: string;
  from?: string;
  id?: string;
  text?: {
    body?: string;
  };
};

type WhatsAppWebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[];
      };
    }>;
  }>;
};

type SlackEvent = {
  type?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  channel?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};

type SlackEventBody = {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
};

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly aiService: AiService,
    private readonly whatsappService: WhatsappService,
    private readonly redisService: RedisService,
    private readonly slackService: SlackService,
  ) {}

  async generateResponse(prompt: string): Promise<string> {
    return this.aiService.generateResponse(prompt);
  }

  async generateClaudeResponse(prompt: string): Promise<string> {
    return this.aiService.generateClaudeResponseWithHistory([
      { role: 'user', content: prompt },
    ]);
  }

  async handleStreamPrompt(
    prompt: string,
    emit: (data: object) => void,
    history?: ChatMessage[],
    attachments?: Attachment[],
  ): Promise<void> {
    const userMessage: ChatMessage = { role: 'user', content: prompt };
    if (attachments?.length) userMessage.attachments = attachments;

    const messages: ChatMessage[] = [
      ...(history ?? []).slice(-HISTORY_LIMIT),
      userMessage,
    ];
    const { fullStream } = this.aiService.streamResponseWithHistory(messages);

    let textDeltaCount = 0;
    try {
      for await (const part of fullStream) {
        switch (part.type) {
          case 'text-delta':
            textDeltaCount++;
            emit({ t: 'text', v: part.text });
            break;
          case 'tool-call':
            this.logger.log(`Tool call: ${part.toolName}`);
            if (part.toolName === 'webSearch') {
              emit({ t: 'searching' });
            }
            break;
          case 'tool-result':
            this.logger.log(`Tool result: ${part.toolName}`);
            if (part.toolName === 'webSearch') {
              emit({ t: 'search_done' });
            }
            break;
          case 'reasoning-delta':
            emit({ t: 'reasoning', v: part.text });
            break;
          case 'finish':
            this.logger.log(
              `Stream finished — text deltas: ${textDeltaCount}, reason: ${part.finishReason}`,
            );
            emit({ t: 'done' });
            break;
          case 'error':
            this.logger.error(
              `Stream error event: ${JSON.stringify(part.error)}`,
            );
            break;
        }
      }
      if (textDeltaCount === 0) {
        this.logger.warn(
          'Stream finished with no text from the model. Check AI_GATEWAY_API_KEY and model.',
        );
      }
    } catch (err: unknown) {
      const normalized = err as {
        message?: string;
        stack?: string;
        cause?: { message?: string; responseBody?: unknown };
      };
      this.logger.error('Stream error', normalized.stack ?? String(err));

      // Fallback for streaming failures: return a complete Claude response as one final text chunk.
      if (this.aiService.isClaudeConfigured()) {
        try {
          const fallbackText =
            await this.aiService.generateClaudeResponseWithHistory(messages);
          if (fallbackText.trim()) {
            emit({ t: 'text', v: fallbackText });
            emit({ t: 'done' });
            return;
          }
        } catch (fallbackErr: unknown) {
          this.logger.error(
            'Claude stream fallback failed',
            String(fallbackErr),
          );
        }
      }

      const msg =
        normalized.message ??
        normalized.cause?.message ??
        (typeof normalized.cause?.responseBody === 'string'
          ? normalized.cause.responseBody
          : null) ??
        'Stream error';
      emit({ t: 'error', msg });
    }
  }

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const verificationToken =
      process.env.WHATSAPP_CLOUD_API_WEBHOOK_VERIFICATION_TOKEN;

    if (mode === 'subscribe' && token === verificationToken) {
      return challenge;
    }

    return null;
  }

  async handleIncomingMessage(body: WhatsAppWebhookBody): Promise<void> {
    const { messages } = body?.entry?.[0]?.changes?.[0]?.value ?? {};
    if (!messages) return;

    const message = messages[0];
    if (message.type !== 'text') return;

    const phoneNumber = message.from?.trim();
    const messageID = message.id?.trim();
    const userText = message.text?.body?.trim();
    if (!phoneNumber || !messageID || !userText) return;

    // Mark as read + show typing indicator
    await this.whatsappService.sendReadWithTyping(messageID);

    // Load history from Redis
    const historyKey = `chat:history:${phoneNumber}`;
    const history: ChatMessage[] =
      (await this.redisService.get(historyKey)) ?? [];

    // Build messages for AI (last N + new user message)
    const aiMessages: ChatMessage[] = [
      ...history.slice(-HISTORY_LIMIT),
      { role: 'user', content: userText },
    ];

    // Generate response with history
    const aiResponse =
      await this.aiService.generateResponseWithHistory(aiMessages);

    // Persist updated history to Redis (with TTL)
    await this.redisService.set(
      historyKey,
      [...aiMessages, { role: 'assistant', content: aiResponse }],
      HISTORY_TTL_SECONDS,
    );

    // Send reply
    await this.whatsappService.sendMessage(phoneNumber, messageID, aiResponse);
  }

  handleSlackChallenge(challenge: string): { challenge: string } {
    return { challenge };
  }

  async handleSlackEvent(body: SlackEventBody): Promise<void> {
    const event = body.event;

    if (!event) {
      this.logger.warn('[Slack] No event in payload');
      return;
    }
    if (event.bot_id || event.subtype) {
      this.logger.debug(
        `[Slack] Ignoring event — bot_id: ${event.bot_id}, subtype: ${event.subtype}`,
      );
      return;
    }
    if (event.type !== 'app_mention' && event.type !== 'message') {
      this.logger.debug(
        `[Slack] Ignoring unsupported event type: ${event.type}`,
      );
      return;
    }

    const eventId = body.event_id?.trim();
    if (eventId) {
      const dedupKey = `slack:event:${eventId}`;
      const seen = await this.redisService.get(dedupKey);
      if (seen) {
        this.logger.log(`Duplicate Slack event ${eventId}, skipping`);
        return;
      }
      await this.redisService.set(dedupKey, '1', SLACK_EVENT_DEDUP_TTL);
    }

    const userText = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!userText) {
      this.logger.debug(
        '[Slack] Empty user text after stripping mentions, skipping',
      );
      return;
    }

    const channel = event.channel?.trim();
    const threadTs = (event.thread_ts ?? event.ts ?? '').trim();
    const userId = event.user?.trim();
    if (!channel || !threadTs || !userId) {
      this.logger.warn('[Slack] Missing channel/thread/user in event payload');
      return;
    }

    this.logger.log(`[Slack] ${userId} in ${channel}: "${userText}"`);

    const historyKey = `slack:history:${channel}:${userId}`;
    const history: ChatMessage[] =
      (await this.redisService.get(historyKey)) ?? [];

    const aiMessages: ChatMessage[] = [
      ...history.slice(-HISTORY_LIMIT),
      { role: 'user', content: userText },
    ];

    const aiResponse =
      await this.aiService.generateResponseWithHistory(aiMessages);

    if (!aiResponse?.trim()) {
      this.logger.warn('[Slack] AI returned an empty response, skipping send');
      return;
    }

    await this.redisService.set(
      historyKey,
      [...aiMessages, { role: 'assistant', content: aiResponse }],
      HISTORY_TTL_SECONDS,
    );

    await this.slackService.sendMessage(channel, aiResponse, threadTs);
    this.logger.log(`[Slack] Response sent to ${channel}`);
  }
}
