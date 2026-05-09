import { Global, Module } from '@nestjs/common';
import { ClaudeAiService } from './claude-ai.service';
import { ClaudeDbToolService } from './claude-db-tool.service';

@Global()
@Module({
  providers: [ClaudeAiService, ClaudeDbToolService],
  exports: [ClaudeAiService, ClaudeDbToolService],
})
export class ClaudeAiModule {}
