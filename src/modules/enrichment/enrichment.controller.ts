import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { EnrichmentJobQueueService } from 'src/lib/enrichment/enrichment.job-queue.service';
import { EnrichmentSchedulerService } from 'src/lib/enrichment/enrichment.scheduler.service';
import { EnrichmentContextService } from 'src/lib/enrichment/enrichment.context.service';

@Controller('enrichment')
export class EnrichmentController {
  constructor(
    private readonly queue: EnrichmentJobQueueService,
    private readonly scheduler: EnrichmentSchedulerService,
    private readonly context: EnrichmentContextService,
  ) {}

  @Post('dead-letter/replay')
  @HttpCode(HttpStatus.OK)
  async replayDeadLetter(@Body('jobId') jobId: string) {
    const replayed = await this.queue.replayDeadLetterJob(jobId);
    return { replayed, jobId };
  }

  @Get('jobs/:id')
  async getJobDetails(@Param('id') id: string) {
    const details = await this.queue.getJobDetails(id);
    if (!details.job) {
      throw new NotFoundException(`Enrichment job not found: ${id}`);
    }
    return details;
  }

  @Get('jobs')
  async listJobs(@Query('status') status?: string) {
    const jobs = await this.queue.listJobs(status);
    return {
      count: jobs.length,
      statusFilter: status ?? null,
      jobs,
    };
  }

  @Get('health')
  async health() {
    const scheduler = await this.scheduler.getStatus();
    const queue = await this.queue.getQueueMetrics();
    return { scheduler, queue };
  }

  @Post('scheduler/toggle')
  @HttpCode(HttpStatus.OK)
  async toggleScheduler(@Body('enabled') enabled: boolean) {
    await this.scheduler.setEnabled(Boolean(enabled));
    return { enabled: Boolean(enabled) };
  }

  @Post('scan/trigger')
  @HttpCode(HttpStatus.OK)
  async triggerScan() {
    await this.scheduler.runCycle();
    return { triggered: true };
  }

  @Post('tuning')
  @HttpCode(HttpStatus.OK)
  async updateTuning(
    @Body('sourceWeights') sourceWeights?: Record<string, number>,
    @Body('fieldThresholds') fieldThresholds?: Record<string, number>,
  ) {
    const current = await this.context.getContext();
    await this.context.patchContext({
      runtimeTuning: {
        sourceWeights: sourceWeights ?? current.runtimeTuning?.sourceWeights ?? {},
        fieldThresholds:
          fieldThresholds ?? current.runtimeTuning?.fieldThresholds ?? {},
      },
    });
    return { updated: true };
  }
}
