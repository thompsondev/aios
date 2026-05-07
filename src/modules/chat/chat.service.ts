import { Injectable, Logger } from '@nestjs/common';
import {
  AiService,
  ChatMessage,
  Attachment,
  AiProvider,
} from '../../lib/ai/ai.service';
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

type NetworkStatus = 'ok' | 'degraded' | 'offline';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly aiService: AiService,
    private readonly whatsappService: WhatsappService,
    private readonly redisService: RedisService,
    private readonly slackService: SlackService,
  ) {}

  private isSearchToolName(toolName: string | undefined): boolean {
    return (
      toolName === 'webSearch' ||
      toolName === 'claude:web_search' ||
      toolName === 'claude:web_fetch'
    );
  }

  private isConnectivityFailureMessage(msg: string): boolean {
    const m = msg.toLowerCase();
    return (
      m.includes('no internet connection') ||
      m.includes('dns resolution failed') ||
      m.includes('network connection issue') ||
      m.includes('connection timeout') ||
      m.includes('internet connection dropped')
    );
  }

  private getNetworkStatusFromMessage(msg: string): NetworkStatus {
    const m = msg.toLowerCase();
    if (
      m.includes('no internet connection') ||
      m.includes('dns resolution failed') ||
      m.includes('enotfound') ||
      m.includes('getaddrinfo')
    ) {
      return 'offline';
    }
    if (
      m.includes('network connection issue') ||
      m.includes('connection timeout') ||
      m.includes('internet connection dropped') ||
      m.includes('socket hang up') ||
      m.includes('timed out')
    ) {
      return 'degraded';
    }
    return 'ok';
  }

  async generateResponse(prompt: string): Promise<string> {
    return this.aiService.generateResponse(prompt);
  }

  async generateResponseWithProvider(
    prompt: string,
  ): Promise<{ text: string; provider: AiProvider }> {
    return this.aiService.generateResponseWithHistoryAndProvider([
      { role: 'user', content: prompt },
    ]);
  }

  async generateClaudeResponse(prompt: string): Promise<string> {
    return this.aiService.generateClaudeResponseWithHistory([
      { role: 'user', content: prompt },
    ]);
  }

  getPreferredProvider(): AiProvider {
    return this.aiService.isClaudeConfigured() ? 'claude' : 'gateway';
  }

  async handleStreamPrompt(
    prompt: string,
    emit: (data: object) => void,
    history?: ChatMessage[],
    attachments?: Attachment[],
  ): Promise<AiProvider> {
    const userMessage: ChatMessage = { role: 'user', content: prompt };
    if (attachments?.length) userMessage.attachments = attachments;

    const messages: ChatMessage[] = [
      ...(history ?? []).slice(-HISTORY_LIMIT),
      userMessage,
    ];
    const { fullStream, actualProviderRef } =
      this.aiService.streamResponseWithHistory(messages);

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
            if (this.isSearchToolName(part.toolName)) {
              emit({ t: 'searching' });
            }
            break;
          case 'tool-result':
            this.logger.log(`Tool result: ${part.toolName}`);
            if (this.isSearchToolName(part.toolName)) {
              emit({ t: 'search_done' });
            }
            break;
          case 'reasoning-delta':
            emit({ t: 'reasoning', v: part.text });
            break;
          case 'finish':
            this.logger.log(
              `Stream finished — served by ${actualProviderRef.current}, text deltas: ${textDeltaCount}, reason: ${part.finishReason}`,
            );
            emit({ t: 'done' });
            return actualProviderRef.current;
          case 'error':
            this.logger.error(
              `Stream error event: ${JSON.stringify(part.error)}`,
            );
            {
              const emitted =
                (part as { error?: { message?: string } }).error?.message ??
                'Stream error';
              const networkStatus = this.getNetworkStatusFromMessage(emitted);
              if (networkStatus !== 'ok') {
                emit({ t: 'network_status', v: networkStatus });
              }
              emit({ t: 'error', msg: emitted });
              return actualProviderRef.current;
            }
        }
      }
      if (textDeltaCount === 0) {
        this.logger.warn(
          'Stream finished with no text from the model. Check AI_GATEWAY_API_KEY and model.',
        );
      }
      emit({ t: 'network_status', v: 'ok' });
    } catch (err: unknown) {
      const normalized = err as {
        message?: string;
        stack?: string;
        cause?: { message?: string; responseBody?: unknown };
      };
      this.logger.error('Stream error', normalized.stack ?? String(err));
      const precomputedMsg =
        normalized.message ??
        normalized.cause?.message ??
        (typeof normalized.cause?.responseBody === 'string'
          ? normalized.cause.responseBody
          : null) ??
        'Stream error';

      // Fallback for streaming failures: return a complete Claude response as one final text chunk.
      if (
        this.aiService.isClaudeConfigured() &&
        !this.isConnectivityFailureMessage(precomputedMsg)
      ) {
        try {
          const fallbackText =
            await this.aiService.generateClaudeResponseWithHistory(messages);
          if (fallbackText.trim()) {
            emit({ t: 'text', v: fallbackText });
            emit({ t: 'network_status', v: 'ok' });
            emit({ t: 'done' });
            return 'claude';
          }
        } catch (fallbackErr: unknown) {
          this.logger.error(
            'Claude stream fallback failed',
            String(fallbackErr),
          );
        }
      }

      const networkStatus = this.getNetworkStatusFromMessage(precomputedMsg);
      if (networkStatus !== 'ok') {
        emit({ t: 'network_status', v: networkStatus });
      }
      emit({ t: 'error', msg: precomputedMsg });
      return actualProviderRef.current;
    }

    return actualProviderRef.current;
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
