import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentContextService } from './enrichment.context.service';
import { EnrichmentJobQueueService } from './enrichment.job-queue.service';
import { EnrichmentPlannerService } from './enrichment.planner.service';
import { EnrichmentScannerService } from './enrichment.scanner.service';
import { isTransientDatabaseError } from './enrichment.db-errors';

@Injectable()
export class EnrichmentSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(EnrichmentSchedulerService.name);
  private readonly intervalMs = Number(process.env.ENRICHMENT_INTERVAL_MS ?? 5 * 60 * 1000);
  private readonly scanLimit = Number(process.env.ENRICHMENT_SCAN_LIMIT ?? 50);
  private running = false;
  private enabled = true;
  private lastStats: Record<string, unknown> = {
    candidates: 0,
    planned: 0,
    enqueued: 0,
    lastRunAt: null,
  };

  constructor(
    private readonly scanner: EnrichmentScannerService,
    private readonly planner: EnrichmentPlannerService,
    private readonly queue: EnrichmentJobQueueService,
    private readonly context: EnrichmentContextService,
  ) {}

  onModuleInit(): void {
    void this.bootstrapState().catch((err) => {
      const msg = String((err as Error)?.message ?? err);
      if (isTransientDatabaseError(err)) {
        this.logger.warn(`[enrichment-scheduler] bootstrap deferred (DB unreachable): ${msg}`);
      } else {
        this.logger.error(`[enrichment-scheduler] bootstrap failed: ${msg}`);
      }
    });
    setInterval(() => {
      void this.runCycle().catch((err) => {
        const msg = String((err as Error)?.message ?? err);
        if (isTransientDatabaseError(err)) {
          this.logger.warn(`[enrichment-scheduler] runCycle skipped (DB unreachable): ${msg}`);
        } else {
          this.logger.error(`[enrichment-scheduler] runCycle error: ${msg}`);
        }
      });
    }, this.intervalMs);
  }

  async runCycle(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const candidates = await this.scanner.scanCatalogCoreMissingFields(this.scanLimit);
      const plan = this.planner.buildPlan(candidates);
      const enqueued = await this.queue.enqueueFromPlan(plan);
      await this.context.updateLastRun();
      this.lastStats = {
        candidates: candidates.length,
        planned: plan.length,
        enqueued,
        lastRunAt: new Date().toISOString(),
      };

      this.logger.log(
        `[enrichment-scheduler] candidates=${candidates.length} planned=${plan.length} enqueued=${enqueued}`,
      );
    } catch (error: unknown) {
      const msg = String((error as Error)?.message ?? error);
      if (isTransientDatabaseError(error)) {
        this.logger.warn(
          `[enrichment-scheduler] cycle skipped (DB unreachable), will retry on next interval: ${msg}`,
        );
      } else {
        this.logger.error(`[enrichment-scheduler] cycle failed: ${msg}`);
      }
    } finally {
      this.running = false;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.context.patchContext({ schedulerEnabled: enabled });
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      scanLimit: this.scanLimit,
      ...this.lastStats,
    };
  }

  private async bootstrapState(): Promise<void> {
    try {
      const ctx = await this.context.getContext();
      this.enabled = ctx.schedulerEnabled ?? true;
      if (this.enabled) {
        await this.runCycle();
      }
    } catch (error: unknown) {
      const msg = String((error as Error)?.message ?? error);
      if (isTransientDatabaseError(error)) {
        this.logger.warn(`[enrichment-scheduler] bootstrapState (DB unreachable): ${msg}`);
      } else {
        this.logger.error(`[enrichment-scheduler] bootstrapState: ${msg}`);
      }
    }
  }
}
