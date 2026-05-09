import { Injectable } from '@nestjs/common';
import type { ExtractionOutput } from './enrichment.types';
import { EnrichmentSourceTrustService } from './enrichment.source-trust.service';

@Injectable()
export class EnrichmentConflictResolverService {
  constructor(private readonly trust: EnrichmentSourceTrustService) {}

  async resolve(extraction: ExtractionOutput): Promise<{
    value: unknown;
    conflict: boolean;
    reason: string;
  }> {
    const candidates = extraction.candidates ?? [];
    if (candidates.length <= 1) {
      return {
        value: extraction.value,
        conflict: false,
        reason: 'single_or_no_candidate',
      };
    }

    const normalized = candidates.map((c) => String(c.value ?? '').trim());
    const unique = [...new Set(normalized.filter(Boolean))];
    if (unique.length <= 1) {
      return { value: unique[0] ?? extraction.value, conflict: false, reason: 'same_value' };
    }

    // deterministic winner by highest source trust
    let bestValue: unknown = extraction.value;
    let bestWeight = -1;
    for (const c of candidates) {
      const domain = this.extractDomain(c.sourceUrl);
      const w = await this.trust.getWeight(domain);
      if (w > bestWeight) {
        bestWeight = w;
        bestValue = c.value;
      }
    }

    return { value: bestValue, conflict: true, reason: 'resolved_by_source_weight' };
  }

  private extractDomain(url?: string): string {
    if (!url) return 'unknown';
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'unknown';
    }
  }
}
