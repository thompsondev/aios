import { Injectable } from '@nestjs/common';
import { EnrichmentContextService } from './enrichment.context.service';

@Injectable()
export class EnrichmentSourceTrustService {
  private readonly weights: Record<string, number> = {
    'apple.com': 1.0,
    'samsung.com': 1.0,
    'google.com': 1.0,
    'amazon.com': 0.85,
    'bestbuy.com': 0.85,
    'cdw.com': 0.8,
    'keepa.com': 0.7,
  };

  constructor(private readonly context: EnrichmentContextService) {}

  async getWeight(domain: string): Promise<number> {
    const ctx = await this.context.getContext();
    const overrides = ctx.runtimeTuning?.sourceWeights ?? {};
    return overrides[domain] ?? this.weights[domain] ?? 0.5;
  }
}
