import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ClaudeAiService } from './claude-ai.service';

@Global()
@Module({
  imports: [HttpModule],
  providers: [ClaudeAiService],
  exports: [ClaudeAiService],
})
export class ClaudeAiModule {}
