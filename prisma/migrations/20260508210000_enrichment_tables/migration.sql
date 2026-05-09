-- Enrichment pipeline tables (catalog AI enrichment jobs, logs, sources, confidence)

CREATE TABLE "enrichment_jobs" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMP(6),
    "last_error" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(6),

    CONSTRAINT "enrichment_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "enrichment_logs" (
    "id" TEXT NOT NULL,
    "enrichment_job_id" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichment_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "source_tracking" (
    "id" TEXT NOT NULL,
    "enrichment_job_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "source_domain" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "signal_type" TEXT,
    "extraction_status" TEXT NOT NULL DEFAULT 'captured',
    "extracted_value" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_tracking_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "confidence_scores" (
    "id" TEXT NOT NULL,
    "enrichment_job_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "level" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasons" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "confidence_scores_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_enrichment_jobs_status" ON "enrichment_jobs"("status");
CREATE INDEX "idx_enrichment_jobs_next_attempt_at" ON "enrichment_jobs"("next_attempt_at");
CREATE INDEX "idx_enrichment_jobs_entity_record" ON "enrichment_jobs"("entity", "record_id");
CREATE INDEX "idx_enrichment_jobs_created_at" ON "enrichment_jobs"("created_at");

CREATE INDEX "idx_enrichment_logs_job_id" ON "enrichment_logs"("enrichment_job_id");
CREATE INDEX "idx_enrichment_logs_event" ON "enrichment_logs"("event");
CREATE INDEX "idx_enrichment_logs_created_at" ON "enrichment_logs"("created_at");

CREATE INDEX "idx_source_tracking_job_id" ON "source_tracking"("enrichment_job_id");
CREATE INDEX "idx_source_tracking_entity_record_field" ON "source_tracking"("entity", "record_id", "field");
CREATE INDEX "idx_source_tracking_domain" ON "source_tracking"("source_domain");

CREATE INDEX "idx_confidence_scores_job_id" ON "confidence_scores"("enrichment_job_id");
CREATE INDEX "idx_confidence_scores_entity_record_field" ON "confidence_scores"("entity", "record_id", "field");
CREATE INDEX "idx_confidence_scores_score" ON "confidence_scores"("score");

ALTER TABLE "enrichment_logs" ADD CONSTRAINT "enrichment_logs_enrichment_job_id_fkey" FOREIGN KEY ("enrichment_job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "source_tracking" ADD CONSTRAINT "source_tracking_enrichment_job_id_fkey" FOREIGN KEY ("enrichment_job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "confidence_scores" ADD CONSTRAINT "confidence_scores_enrichment_job_id_fkey" FOREIGN KEY ("enrichment_job_id") REFERENCES "enrichment_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
