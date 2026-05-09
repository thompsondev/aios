import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { EnrichmentApiModule } from './enrichment/enrichment.module';

@Module({
  imports: [ChatModule, EnrichmentApiModule],
})
export class V1Module {}
