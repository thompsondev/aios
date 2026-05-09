import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { ENRICHMENT_CONTEXT_KEY, TRUSTED_DOMAINS } from './enrichment.constants';
import type { EnrichmentContextMemory } from './enrichment.types';

@Injectable()
export class EnrichmentContextService {
  constructor(private readonly redis: RedisService) {}

  async getContext(): Promise<EnrichmentContextMemory> {
    const existing = await this.redis.get(ENRICHMENT_CONTEXT_KEY);
    if (existing) return existing as EnrichmentContextMemory;

    const initial: EnrichmentContextMemory = {
      schemaVersion: 'catalog-core-v1',
      trustedDomains: TRUSTED_DOMAINS,
      lastRunAt: new Date(0).toISOString(),
      failedAttempts: [],
    };

    await this.redis.set(ENRICHMENT_CONTEXT_KEY, initial);
    return initial;
  }

  async updateLastRun(): Promise<void> {
    const ctx = await this.getContext();
    await this.redis.set(ENRICHMENT_CONTEXT_KEY, {
      ...ctx,
      lastRunAt: new Date().toISOString(),
    });
  }

  async patchContext(partial: Partial<EnrichmentContextMemory>): Promise<void> {
    const ctx = await this.getContext();
    await this.redis.set(ENRICHMENT_CONTEXT_KEY, {
      ...ctx,
      ...partial,
    });
  }
}
