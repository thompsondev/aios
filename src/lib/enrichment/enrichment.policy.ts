import { Injectable } from '@nestjs/common';
import { ENRICHABLE_FIELDS, PROTECTED_FIELDS } from './enrichment.constants';
import type { CatalogEntity } from './enrichment.types';

@Injectable()
export class EnrichmentPolicyService {
  isFieldProtected(entity: CatalogEntity, field: string): boolean {
    return PROTECTED_FIELDS[entity].includes(field);
  }

  isFieldEnrichable(entity: CatalogEntity, field: string): boolean {
    return ENRICHABLE_FIELDS[entity].includes(field);
  }

  getEnrichableFields(entity: CatalogEntity): string[] {
    return ENRICHABLE_FIELDS[entity];
  }

  assertAllowedUpdate(entity: CatalogEntity, field: string): void {
    if (this.isFieldProtected(entity, field)) {
      throw new Error(
        `[enrichment-policy] ${entity}.${field} is protected and cannot be updated by AI enrichment`,
      );
    }
    if (!this.isFieldEnrichable(entity, field)) {
      throw new Error(
        `[enrichment-policy] ${entity}.${field} is not in the enrichment allow-list`,
      );
    }
  }
}
