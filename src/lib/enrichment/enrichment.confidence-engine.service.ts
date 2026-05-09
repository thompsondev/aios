import { Injectable } from '@nestjs/common';
import type {
  CatalogEntity,
  ConfidenceResult,
  ExtractionOutput,
  ValidationResult,
} from './enrichment.types';
import { EnrichmentSourceTrustService } from './enrichment.source-trust.service';
import { EnrichmentThresholdsService } from './enrichment.thresholds.service';

@Injectable()
export class EnrichmentConfidenceEngineService {
  constructor(
    private readonly sourceTrust: EnrichmentSourceTrustService,
    private readonly thresholds: EnrichmentThresholdsService,
  ) {}

  async score(
    entity: CatalogEntity,
    field: string,
    extraction: ExtractionOutput,
    validation: ValidationResult,
  ): Promise<ConfidenceResult> {
    let score = 0;
    const reasons: string[] = [];

    if (validation.ok) {
      score += 0.5;
      reasons.push('validation_passed');
    } else {
      reasons.push(...validation.reasons);
    }

    const sourceCount = extraction.sources.length;
    if (sourceCount >= 2) {
      score += 0.2;
      reasons.push('multiple_sources');
    } else if (sourceCount === 1) {
      score += 0.1;
      reasons.push('single_source');
    }

    let avgTrust = 0.5;
    if (extraction.sources.length > 0) {
      let sum = 0;
      for (const source of extraction.sources) {
        sum += await this.sourceTrust.getWeight(source.domain);
      }
      avgTrust = sum / extraction.sources.length;
    }
    score += Math.min(0.2, avgTrust * 0.2);
    reasons.push(`avg_source_trust_${avgTrust.toFixed(2)}`);

    if (extraction.rationale !== 'uncertain' && extraction.value != null) {
      score += 0.1;
      reasons.push('extractor_rationale_present');
    }

    score = Math.min(1, Math.max(0, score));
    const level = score >= 0.85 ? 'high' : score >= 0.65 ? 'medium' : 'low';
    const minRequired = await this.thresholds.getMinScore(entity, field);
    const decision = score >= minRequired ? 'approve' : 'reject';
    reasons.push(`min_required_${minRequired.toFixed(2)}`);

    return { score, level, decision, reasons };
  }
}
