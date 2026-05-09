export type CatalogEntity =
  | 'products'
  | 'product_variants'
  | 'brands'
  | 'categories';

export type EnrichmentConfidence = 'high' | 'medium' | 'low';

export type EnrichmentStatus =
  | 'pending'
  | 'needs_review'
  | 'ready_for_update'
  | 'skipped';

export type MissingFieldCandidate = {
  entity: CatalogEntity;
  recordId: string;
  missingFields: string[];
};

export type EnrichmentPlanItem = {
  entity: CatalogEntity;
  recordId: string;
  field: string;
  status: EnrichmentStatus;
  reason: string;
  minConfidence: EnrichmentConfidence;
};

export type EnrichmentContextMemory = {
  schemaVersion: string;
  trustedDomains: string[];
  lastRunAt: string;
  schedulerEnabled?: boolean;
  scanCursor?: {
    productsUpdatedAt?: string;
    productVariantsUpdatedAt?: string;
    brandsUpdatedAt?: string;
    categoriesUpdatedAt?: string;
  };
  runtimeTuning?: {
    sourceWeights?: Record<string, number>;
    fieldThresholds?: Record<string, number>;
  };
  failedAttempts: Array<{
    entity: CatalogEntity;
    recordId: string;
    field: string;
    reason: string;
    at: string;
  }>;
};

export type SourceCandidate = {
  domain: string;
  url: string;
  snippet?: string;
};

export type ExtractionOutput = {
  value: unknown;
  sources: SourceCandidate[];
  rationale: string;
  candidates?: Array<{
    value: unknown;
    sourceUrl?: string;
  }>;
};

export type ValidationResult = {
  ok: boolean;
  normalizedValue: unknown;
  reasons: string[];
};

export type ConfidenceResult = {
  score: number;
  level: EnrichmentConfidence;
  decision: 'approve' | 'reject';
  reasons: string[];
};
