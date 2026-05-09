import { Module } from '@nestjs/common';
import { EnrichmentController } from './enrichment.controller';

@Module({
  controllers: [EnrichmentController],
})
export class EnrichmentApiModule {}
