import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { EnrichmentPolicyService } from './enrichment.policy';
import { EnrichmentScannerService } from './enrichment.scanner.service';
import { EnrichmentContextService } from './enrichment.context.service';
import { EnrichmentPlannerService } from './enrichment.planner.service';
import { EnrichmentJobQueueService } from './enrichment.job-queue.service';
import { EnrichmentSchedulerService } from './enrichment.scheduler.service';
import { EnrichmentWorkerService } from './enrichment.worker.service';
import { EnrichmentSearchOrchestratorService } from './enrichment.search-orchestrator.service';
import { EnrichmentScraperFetcherService } from './enrichment.scraper-fetcher.service';
import { EnrichmentAiExtractorService } from './enrichment.ai-extractor.service';
import { EnrichmentValidatorService } from './enrichment.validator.service';
import { EnrichmentConfidenceEngineService } from './enrichment.confidence-engine.service';
import { EnrichmentDbUpdateService } from './enrichment.db-update.service';
import { AiModule } from '../ai/ai.module';
import { EnrichmentSourceTrustService } from './enrichment.source-trust.service';
import { EnrichmentThresholdsService } from './enrichment.thresholds.service';
import { EnrichmentStaleDetectorService } from './enrichment.stale-detector.service';
import { EnrichmentConflictResolverService } from './enrichment.conflict-resolver.service';

@Global()
@Module({
  imports: [PrismaModule, RedisModule, AiModule],
  providers: [
    EnrichmentPolicyService,
    EnrichmentScannerService,
    EnrichmentContextService,
    EnrichmentPlannerService,
    EnrichmentJobQueueService,
    EnrichmentSearchOrchestratorService,
    EnrichmentScraperFetcherService,
    EnrichmentAiExtractorService,
    EnrichmentValidatorService,
    EnrichmentSourceTrustService,
    EnrichmentThresholdsService,
    EnrichmentConfidenceEngineService,
    EnrichmentStaleDetectorService,
    EnrichmentConflictResolverService,
    EnrichmentDbUpdateService,
    EnrichmentSchedulerService,
    EnrichmentWorkerService,
  ],
  exports: [
    EnrichmentPolicyService,
    EnrichmentScannerService,
    EnrichmentContextService,
    EnrichmentPlannerService,
    EnrichmentJobQueueService,
    EnrichmentSchedulerService,
  ],
})
export class EnrichmentModule {}
