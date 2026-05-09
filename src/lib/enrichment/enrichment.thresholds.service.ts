import { Injectable } from '@nestjs/common';
import { EnrichmentContextService } from './enrichment.context.service';
import type { CatalogEntity } from './enrichment.types';

@Injectable()
export class EnrichmentThresholdsService {
  constructor(private readonly context: EnrichmentContextService) {}

  async getMinScore(entity: CatalogEntity, field: string): Promise<number> {
    const ctx = await this.context.getContext();
    const key = `${entity}.${field}`;
    const override = ctx.runtimeTuning?.fieldThresholds?.[key];
    if (typeof override === 'number') return override;

    if (field.includes('image') || field.includes('url')) return 0.9;
    if (field.startsWith('seo_')) return 0.8;
    if (entity === 'product_variants' && field === 'mpn') return 0.95;
    return 0.85;
  }
}
