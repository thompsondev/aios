import { Injectable } from '@nestjs/common';
import type { CatalogEntity } from './enrichment.types';

@Injectable()
export class EnrichmentSearchOrchestratorService {
  buildQuery(
    entity: CatalogEntity,
    field: string,
    record: Record<string, unknown>,
  ): string {
    const name = String(record.name ?? record.title ?? '').trim();
    const brand = String(record.brand_name ?? '').trim();
    const model = String(record.model_number ?? '').trim();
    const mpn = String(record.mpn ?? '').trim();

    const baseIdentity = [brand, name, model, mpn].filter(Boolean).join(' ');

    if (field.includes('image')) {
      return `${baseIdentity} product image site:amazon.com OR site:bestbuy.com OR site:cdw.com`;
    }
    if (field.startsWith('seo_') || field.includes('description')) {
      return `${baseIdentity} official specifications`;
    }
    if (field === 'website' || field === 'logo_url') {
      return `${name} official website`;
    }

    return `${entity} ${baseIdentity} ${field} official`;
  }
}
