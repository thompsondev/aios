import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import moment from 'moment-timezone';

const WINDOW_TZ = 'Africa/Lagos';
const DEFAULT_PROMPTS_PER_DAY_WHEN_DOMAIN_CHAT_SET = 5;

@Injectable()
export class OpenAccessPromptLimitGuard implements CanActivate {
  private readonly store = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const apiKey = this.configService.get<string>('API_KEY');
    const domainChatRaw = this.configService.get<string>('DOMAIN_CHAT');
    const domainChatSet = domainChatRaw
      ? new Set(
          domainChatRaw
            .split(',')
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean),
        )
      : null;

    if (apiKey) {
      return true;
    }
    if (!domainChatSet?.size) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const ip = (
      request.ip ||
      request.socket?.remoteAddress ||
      'unknown'
    ).trim();
    const host = (request.get('Host') || '').split(':')[0].toLowerCase();
    if (!domainChatSet.has(host)) {
      return true;
    }

    const dateKey = moment().tz(WINDOW_TZ).format('YYYY-MM-DD');
    const key = `${host}:${ip}:${dateKey}`;
    const promptsPerDayChat = Math.max(
      1,
      Math.floor(
        Number(this.configService.get<string>('PROMPTS_PER_DAY_CHAT')) ||
          DEFAULT_PROMPTS_PER_DAY_WHEN_DOMAIN_CHAT_SET,
      ),
    );
    const maxPrompts = promptsPerDayChat;
    const count = this.store.get(key) ?? 0;
    if (count >= maxPrompts) {
      throw new HttpException(
        `Open access limit: maximum ${maxPrompts} prompts per day per device.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.store.set(key, count + 1);
    return true;
  }
}
