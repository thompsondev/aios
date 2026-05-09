import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobQueueService } from './enrichment.job-queue.service';
import { EnrichmentPolicyService } from './enrichment.policy';
import type { CatalogEntity } from './enrichment.types';
import { EnrichmentSearchOrchestratorService } from './enrichment.search-orchestrator.service';
import { EnrichmentScraperFetcherService } from './enrichment.scraper-fetcher.service';
import { EnrichmentAiExtractorService } from './enrichment.ai-extractor.service';
import { EnrichmentValidatorService } from './enrichment.validator.service';
import { EnrichmentConfidenceEngineService } from './enrichment.confidence-engine.service';
import { EnrichmentDbUpdateService } from './enrichment.db-update.service';
import { EnrichmentStaleDetectorService } from './enrichment.stale-detector.service';
import { EnrichmentConflictResolverService } from './enrichment.conflict-resolver.service';
import { isTransientDatabaseError } from './enrichment.db-errors';
import type { EnrichmentQueuePayload } from './enrichment.job-queue.service';

@Injectable()
export class EnrichmentWorkerService implements OnModuleInit {
  private readonly logger = new Logger(EnrichmentWorkerService.name);
  private readonly pollMs = 4000;
  /** Pause dequeue when DB is flapping (Neon cold start / network). */
  private workerBackoffUntil = 0;
  private consecutiveTransientDb = 0;
  private readonly backoffMaxMs = Number(
    process.env.ENRICHMENT_WORKER_BACKOFF_MAX_MS ?? 120_000,
  );

  constructor(
    private readonly queue: EnrichmentJobQueueService,
    private readonly policy: EnrichmentPolicyService,
    private readonly prisma: PrismaService,
    private readonly searchOrchestrator: EnrichmentSearchOrchestratorService,
    private readonly scraperFetcher: EnrichmentScraperFetcherService,
    private readonly aiExtractor: EnrichmentAiExtractorService,
    private readonly validator: EnrichmentValidatorService,
    private readonly confidenceEngine: EnrichmentConfidenceEngineService,
    private readonly dbUpdateService: EnrichmentDbUpdateService,
    private readonly staleDetector: EnrichmentStaleDetectorService,
    private readonly conflictResolver: EnrichmentConflictResolverService,
  ) {}

  onModuleInit(): void {
    setInterval(() => {
      void this.processNext().catch((err) => {
        this.logger.error(
          `[enrichment-worker] unhandled processNext: ${String((err as Error)?.message ?? err)}`,
        );
      });
    }, this.pollMs);
  }

  private async processNext(): Promise<void> {
    if (Date.now() < this.workerBackoffUntil) {
      return;
    }

    let job: EnrichmentQueuePayload | null = null;
    try {
      job = await this.queue.popNextJob();
    } catch (e: unknown) {
      this.logger.warn(
        `[enrichment-worker] queue pop failed: ${String((e as Error)?.message ?? e)}`,
      );
      return;
    }
    if (!job) return;

    try {
      await this.queue.markJobRunning(job.jobId);
      await this.queue.logJobEvent(
        job.jobId,
        'job_started',
        `Started enrichment for ${job.entity}.${job.field}`,
      );

      this.policy.assertAllowedUpdate(job.entity as CatalogEntity, job.field);

      const record = await this.loadRecord(
        job.entity as CatalogEntity,
        job.recordId,
      );
      if (!record) {
        throw new Error('record_not_found');
      }
      if (!this.staleDetector.isStale(record)) {
        await this.queue.logJobEvent(
          job.jobId,
          'job_skipped',
          `Record not stale enough for enrichment`,
          'info',
        );
        await this.queue.markJobCompleted(job.jobId);
        this.consecutiveTransientDb = 0;
        this.workerBackoffUntil = 0;
        return;
      }

      const query = this.searchOrchestrator.buildQuery(
        job.entity as CatalogEntity,
        job.field,
        record,
      );
      const sources = await this.scraperFetcher.fetchCandidates(query);
      const extraction = await this.aiExtractor.extractFieldValue(
        job.entity,
        job.field,
        record,
        sources,
      );
      const resolved = await this.conflictResolver.resolve(extraction);
      const validation = this.validator.validateFieldValue(
        job.field,
        resolved.value,
      );
      const confidence = await this.confidenceEngine.score(
        job.entity as CatalogEntity,
        job.field,
        extraction,
        validation,
      );

      const confidenceId = randomUUID();
      await this.prisma.$executeRaw`
        INSERT INTO "confidence_scores"
          ("id","enrichment_job_id","entity","record_id","field","score","level","decision","reasons","created_at")
        VALUES
          (${confidenceId}, ${job.jobId}, ${job.entity}, ${job.recordId}, ${job.field}, ${confidence.score}::decimal, ${confidence.level}, ${confidence.decision}, ${JSON.stringify(confidence.reasons)}::jsonb, NOW())
      `;

      for (const source of extraction.sources) {
        const sourceTrackingId = randomUUID();
        await this.prisma.$executeRaw`
          INSERT INTO "source_tracking"
            ("id","enrichment_job_id","entity","record_id","field","source_domain","source_url","signal_type","extraction_status","extracted_value","created_at")
          VALUES
            (${sourceTrackingId}, ${job.jobId}, ${job.entity}, ${job.recordId}, ${job.field}, ${source.domain}, ${source.url}, 'search', ${validation.ok ? 'validated' : 'rejected'}, ${resolved.value == null ? null : String(resolved.value)}, NOW())
        `;
      }

      let updated = false;
      if (confidence.decision === 'approve' && validation.ok) {
        updated = await this.dbUpdateService.updateFieldIfMissing(
          job.entity as CatalogEntity,
          job.recordId,
          job.field,
          validation.normalizedValue,
        );
      }

      await this.queue.logJobEvent(
        job.jobId,
        'job_processed',
        `Phase 3 processed ${job.entity}.${job.field} updated=${updated}`,
        'info',
        {
          confidence: confidence.score,
          level: confidence.level,
          decision: confidence.decision,
          conflict: resolved.conflict,
          conflictReason: resolved.reason,
          validation: validation.reasons,
        },
      );
      await this.queue.markJobCompleted(job.jobId);
      this.consecutiveTransientDb = 0;
      this.workerBackoffUntil = 0;
    } catch (error: unknown) {
      if (isTransientDatabaseError(error)) {
        this.consecutiveTransientDb += 1;
        const base = Math.min(
          this.backoffMaxMs,
          2000 * Math.pow(2, Math.min(this.consecutiveTransientDb - 1, 6)),
        );
        this.workerBackoffUntil = Date.now() + base;
        try {
          await this.queue.requeuePayload(job);
        } catch (requeueErr: unknown) {
          this.logger.error(
            `[enrichment-worker] requeue failed: ${String((requeueErr as Error)?.message ?? requeueErr)}`,
          );
        }
        this.logger.warn(
          `[enrichment-worker] DB unreachable, requeued job ${job.jobId}; backing off ${base}ms (attempt ${this.consecutiveTransientDb})`,
        );
        return;
      }

      this.consecutiveTransientDb = 0;
      const message = String((error as Error)?.message ?? error);
      try {
        await this.queue.logJobEvent(job.jobId, 'job_failed', message, 'error');
        await this.queue.markJobFailed(job.jobId, message);
      } catch (persistErr: unknown) {
        this.logger.error(
          `[enrichment-worker] could not persist failure for ${job.jobId}: ${String((persistErr as Error)?.message ?? persistErr)}`,
        );
      }
      this.logger.warn(`[enrichment-worker] job failed: ${message}`);
    }
  }

  private async loadRecord(
    entity: CatalogEntity,
    recordId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${entity}" WHERE id = $1 LIMIT 1`,
      recordId,
    );
    return rows[0] ?? null;
  }
}
