import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import * as https from 'node:https';
import { ClaudeAiService } from './claude-ai.service';

/** Anthropic can take a long time on long contexts; default axios timeout is too short for some networks. */
const ANTHROPIC_HTTP_TIMEOUT_MS = 600_000;

const anthropicHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 32,
});

@Global()
@Module({
  imports: [
    HttpModule.register({
      timeout: ANTHROPIC_HTTP_TIMEOUT_MS,
      maxRedirects: 0,
      httpsAgent: anthropicHttpsAgent,
    }),
  ],
  providers: [ClaudeAiService],
  exports: [ClaudeAiService],
})
export class ClaudeAiModule {}
