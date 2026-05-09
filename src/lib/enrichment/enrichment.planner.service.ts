import { Injectable } from '@nestjs/common';
import { EnrichmentPolicyService } from './enrichment.policy';
import type {
  EnrichmentPlanItem,
  MissingFieldCandidate,
} from './enrichment.types';

@Injectable()
export class EnrichmentPlannerService {
  constructor(private readonly policy: EnrichmentPolicyService) {}

  buildPlan(candidates: MissingFieldCandidate[]): EnrichmentPlanItem[] {
    const plan: EnrichmentPlanItem[] = [];

    for (const candidate of candidates) {
      for (const field of candidate.missingFields) {
        if (this.policy.isFieldProtected(candidate.entity, field)) {
          plan.push({
            entity: candidate.entity,
            recordId: candidate.recordId,
            field,
            status: 'skipped',
            reason: 'protected_field',
            minConfidence: 'high',
          });
          continue;
        }

        if (!this.policy.isFieldEnrichable(candidate.entity, field)) {
          plan.push({
            entity: candidate.entity,
            recordId: candidate.recordId,
            field,
            status: 'skipped',
            reason: 'not_allowlisted',
            minConfidence: 'high',
          });
          continue;
        }

        plan.push({
          entity: candidate.entity,
          recordId: candidate.recordId,
          field,
          status: 'ready_for_update',
          reason: 'missing_field_detected',
          minConfidence: 'high',
        });
      }
    }

    return plan;
  }
}
