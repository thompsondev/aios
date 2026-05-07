import { Global, Module } from '@nestjs/common';
import { ClaudeAiService } from './claude-ai.service';

@Global()
@Module({
  providers: [ClaudeAiService],
  exports: [ClaudeAiService],
})
export class ClaudeAiModule {}
