import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { EnrichmentConfidence, EnrichmentPlanItem } from './enrichment.types';

const QUEUE_KEY = 'enrichment:catalog-core:queue';

export type EnrichmentQueuePayload = {
  jobId: string;
  entity: string;
  recordId: string;
  field: string;
  minConfidence: EnrichmentConfidence;
};

@Injectable()
export class EnrichmentJobQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async enqueueFromPlan(items: EnrichmentPlanItem[]): Promise<number> {
    let created = 0;

    for (const item of items) {
      if (item.status !== 'ready_for_update') continue;
      const dup = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "enrichment_jobs"
        WHERE
          "entity" = ${item.entity}
          AND "record_id" = ${item.recordId}
          AND "field" = ${item.field}
          AND "status" IN ('pending','running')
        LIMIT 1
      `;
      if (dup.length > 0) continue;

      const jobId = randomUUID();

      await this.prisma.$executeRaw`
        INSERT INTO "enrichment_jobs"
          ("id","entity","record_id","field","status","priority","attempt_count","max_attempts","created_at","updated_at")
        VALUES
          (${jobId}, ${item.entity}, ${item.recordId}, ${item.field}, 'pending', 5, 0, 5, NOW(), NOW())
      `;

      const payload: EnrichmentQueuePayload = {
        jobId,
        entity: item.entity,
        recordId: item.recordId,
        field: item.field,
        minConfidence: item.minConfidence,
      };

      await this.redis.lpush(QUEUE_KEY, JSON.stringify(payload));
      created++;
    }

    return created;
  }

  async popNextJob(): Promise<EnrichmentQueuePayload | null> {
    const raw = await this.redis.rpop(QUEUE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EnrichmentQueuePayload;
  }

  /** Put job back on the head of the queue (e.g. DB temporarily unreachable). */
  async requeuePayload(payload: EnrichmentQueuePayload): Promise<void> {
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(payload));
  }

  async markJobRunning(jobId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "enrichment_jobs"
      SET "status" = 'running', "updated_at" = NOW()
      WHERE "id" = ${jobId}
    `;
  }

  async markJobCompleted(jobId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "enrichment_jobs"
      SET "status" = 'completed', "updated_at" = NOW(), "completed_at" = NOW()
      WHERE "id" = ${jobId}
    `;
  }

  async markJobFailed(jobId: string, errorMessage: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ attempt_count: number; max_attempts: number }>
    >`
      SELECT "attempt_count","max_attempts"
      FROM "enrichment_jobs"
      WHERE "id" = ${jobId}
      LIMIT 1
    `;

    const attemptCount = (rows[0]?.attempt_count ?? 0) + 1;
    const maxAttempts = rows[0]?.max_attempts ?? 5;
    const isDead = attemptCount >= maxAttempts;
    const tooSoonRows = await this.prisma.$queryRaw<Array<{ created_at: Date }>>`
      SELECT "created_at"
      FROM "enrichment_jobs"
      WHERE "id" = ${jobId}
      LIMIT 1
    `;
    const createdAt = tooSoonRows[0]?.created_at;
    const withinRetryWindow =
      !!createdAt && Date.now() - new Date(createdAt).getTime() < 60 * 60 * 1000;

    const backoffMinutes = Math.min(60, Math.pow(2, attemptCount));

    await this.prisma.$executeRaw`
      UPDATE "enrichment_jobs"
      SET
        "status" = ${isDead || withinRetryWindow ? 'dead_letter' : 'pending'},
        "attempt_count" = ${attemptCount},
        "last_error" = ${errorMessage},
        "next_attempt_at" = NOW() + (${backoffMinutes} * INTERVAL '1 minute'),
        "updated_at" = NOW()
      WHERE "id" = ${jobId}
    `;
  }

  async logJobEvent(
    jobId: string,
    event: string,
    message: string,
    level = 'info',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const id = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "enrichment_logs"
        ("id","enrichment_job_id","level","event","message","metadata","created_at")
      VALUES
        (${id}, ${jobId}, ${level}, ${event}, ${message}, ${metadata ? JSON.stringify(metadata) : null}::jsonb, NOW())
    `;
  }

  async replayDeadLetterJob(jobId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; entity: string; record_id: string; field: string }>
    >`
      SELECT "id","entity","record_id","field"
      FROM "enrichment_jobs"
      WHERE "id" = ${jobId} AND "status" = 'dead_letter'
      LIMIT 1
    `;
    const job = rows[0];
    if (!job) return false;

    const payload: EnrichmentQueuePayload = {
      jobId: job.id,
      entity: job.entity,
      recordId: job.record_id,
      field: job.field,
      minConfidence: 'high',
    };

    await this.prisma.$executeRaw`
      UPDATE "enrichment_jobs"
      SET "status" = 'pending', "next_attempt_at" = NOW(), "updated_at" = NOW()
      WHERE "id" = ${jobId}
    `;
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(payload));
    await this.logJobEvent(jobId, 'job_replayed', 'Dead-letter job replayed');
    return true;
  }

  async getJobDetails(jobId: string): Promise<{
    job: Record<string, unknown> | null;
    logs: Record<string, unknown>[];
    confidenceScores: Record<string, unknown>[];
    sourceTracking: Record<string, unknown>[];
  }> {
    const jobs = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT *
      FROM "enrichment_jobs"
      WHERE "id" = ${jobId}
      LIMIT 1
    `;

    const logs = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT *
      FROM "enrichment_logs"
      WHERE "enrichment_job_id" = ${jobId}
      ORDER BY "created_at" ASC
    `;

    const confidenceScores = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`
      SELECT *
      FROM "confidence_scores"
      WHERE "enrichment_job_id" = ${jobId}
      ORDER BY "created_at" DESC
    `;

    const sourceTracking = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`
      SELECT *
      FROM "source_tracking"
      WHERE "enrichment_job_id" = ${jobId}
      ORDER BY "created_at" ASC
    `;

    return {
      job: jobs[0] ?? null,
      logs,
      confidenceScores,
      sourceTracking,
    };
  }

  async listJobs(status?: string): Promise<Record<string, unknown>[]> {
    if (status && status.trim().length > 0) {
      return this.prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          "id",
          "entity",
          "record_id",
          "field",
          "status",
          "attempt_count",
          "max_attempts",
          "next_attempt_at",
          "last_error",
          "created_at",
          "updated_at",
          "completed_at"
        FROM "enrichment_jobs"
        WHERE "status" = ${status}
        ORDER BY "updated_at" DESC
        LIMIT 200
      `;
    }

    return this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        "id",
        "entity",
        "record_id",
        "field",
        "status",
        "attempt_count",
        "max_attempts",
        "next_attempt_at",
        "last_error",
        "created_at",
        "updated_at",
        "completed_at"
      FROM "enrichment_jobs"
      ORDER BY "updated_at" DESC
      LIMIT 200
    `;
  }

  async getQueueMetrics(): Promise<Record<string, unknown>> {
    const byStatus = await this.prisma.$queryRaw<
      Array<{ status: string; count: bigint }>
    >`
      SELECT "status", COUNT(*)::bigint AS "count"
      FROM "enrichment_jobs"
      GROUP BY "status"
    `;
    const deadLetters = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "enrichment_jobs"
      WHERE "status" = 'dead_letter'
    `;
    return {
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: Number(r.count),
      })),
      deadLetterCount: Number(deadLetters[0]?.count ?? 0),
    };
  }
}
