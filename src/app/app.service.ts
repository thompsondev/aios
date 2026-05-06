import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

function isSameOrSubdomain(requestHost: string, platformUrl: string): boolean {
  try {
    const platformHost = new URL(platformUrl).hostname.toLowerCase();
    const host = requestHost.split(':')[0].trim().toLowerCase();
    return host === platformHost || host.endsWith('.' + platformHost);
  } catch {
    return false;
  }
}

@Injectable()
export class AppService {
  constructor(private readonly configService: ConfigService) {}

  getHello(): string {
    return 'Hello World!';
  }

  getBranding(requestHost?: string): {
    authorName: string | null;
    authorUrl: string | null;
  } {
    const authorName = this.configService.get<string>('AUTHOR_NAME') ?? null;
    const authorUrl = this.configService.get<string>('AUTHOR_URL') ?? null;
    const platformUrl = this.configService.get<string>('PLATFORM_URL');

    if (!authorName) {
      return { authorName: null, authorUrl: null };
    }
    if (!requestHost) {
      return { authorName, authorUrl };
    }
    const host = requestHost.split(':')[0].trim().toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      return { authorName, authorUrl };
    }
    if (!platformUrl) {
      return { authorName, authorUrl };
    }
    if (!isSameOrSubdomain(requestHost, platformUrl)) {
      return { authorName: null, authorUrl: null };
    }
    return { authorName, authorUrl };
  }
}
