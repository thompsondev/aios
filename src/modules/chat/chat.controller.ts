import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OpenAccessPromptLimitGuard } from '../../middleware/guards/open-access-prompt-limit.guard';
import { SlackService } from '../../lib/slack/slack.service';
import { Public } from '../../middleware/decorators/public.decorator';

type StreamHistoryItem = { role: 'user' | 'assistant'; content: string };
type StreamAttachment = { name: string; mimeType: string; data: string };

type SlackEventBody = {
  type?: string;
  challenge?: string;
};

type SlackRequestWithRawBody = Request & { rawBody?: string };

@ApiTags('Chat')
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly slackService: SlackService,
  ) {}

  @Post('prompt')
  @UseGuards(OpenAccessPromptLimitGuard)
  @ApiOperation({ summary: 'Generate a response from the AI' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
    },
  })
  async generateResponse(@Body() body: { prompt: string }) {
    return this.chatService.generateResponse(body.prompt);
  }

  @Post('prompt/claude')
  @UseGuards(OpenAccessPromptLimitGuard)
  @ApiOperation({ summary: 'Generate a response directly from Claude' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
    },
  })
  async generateClaudeResponse(@Body() body: { prompt: string }) {
    return this.chatService.generateClaudeResponse(body.prompt);
  }

  @Post('prompt/stream')
  @UseGuards(OpenAccessPromptLimitGuard)
  @ApiOperation({ summary: 'Stream a response from the AI (SSE)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        history: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string' },
            },
          },
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              mimeType: { type: 'string' },
              data: {
                type: 'string',
                description: 'Base64-encoded file content',
              },
            },
          },
        },
      },
    },
  })
  async streamResponse(
    @Body()
    body: {
      prompt: string;
      history?: StreamHistoryItem[];
      attachments?: StreamAttachment[];
    },
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit = (data: object) =>
      res.write(`data: ${JSON.stringify(data)}\n\n`);

    await this.chatService.handleStreamPrompt(
      body.prompt,
      emit,
      body.history,
      body.attachments,
    );

    res.end();
  }

  @Get('webhook')
  @ApiOperation({ summary: 'WhatsApp webhook verification challenge' })
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    return this.chatService.verifyWebhook(mode, token, challenge);
  }

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Handle incoming WhatsApp messages' })
  async handleWebhook(@Body() body: unknown) {
    await this.chatService.handleIncomingMessage(
      body as Parameters<ChatService['handleIncomingMessage']>[0],
    );
    return 'OK';
  }

  @Get('slack/add')
  @Public()
  @ApiOperation({ summary: 'Redirect to Slack OAuth install page' })
  addSlackApp(@Res() res: Response) {
    const url = this.slackService.buildInstallUrl();
    return res.redirect(url);
  }

  @Get('slack/events')
  @Public()
  @ApiOperation({ summary: 'Slack OAuth callback — exchanges code for token' })
  async handleSlackOAuth(
    @Query('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!code) {
      return res.status(400).send('Missing OAuth code');
    }

    const redirectUri = `${req.protocol}://${req.get('host')}${req.path}`;
    const data = await this.slackService.exchangeOAuthCode(code, redirectUri);

    this.logger.log(
      `Slack OAuth success — team: ${data.team?.name} (${data.team?.id})`,
    );

    return res
      .status(200)
      .send(
        `<html><body><h2>Slack app installed successfully!</h2><p>Team: ${data.team?.name}</p></body></html>`,
      );
  }

  @Post('slack/events')
  @HttpCode(200)
  @Public()
  @ApiOperation({ summary: 'Slack Event API webhook' })
  async handleSlackEvents(
    @Req() req: Request,
    @Headers('x-slack-signature') signature: string | undefined,
    @Headers('x-slack-request-timestamp') timestamp: string | undefined,
    @Body() body: SlackEventBody,
  ) {
    const rawBody = (req as SlackRequestWithRawBody).rawBody;

    if (rawBody !== undefined) {
      const isValid =
        typeof signature === 'string' &&
        typeof timestamp === 'string' &&
        this.slackService.verifyRequest(signature, timestamp, rawBody);
      if (!isValid) {
        this.logger.warn('Rejected Slack request — invalid signature');
        throw new UnauthorizedException('Invalid Slack signature');
      }
    }

    if (body.type === 'url_verification') {
      if (!body.challenge) {
        throw new UnauthorizedException('Missing Slack challenge token');
      }
      return this.chatService.handleSlackChallenge(body.challenge);
    }

    if (body.type === 'event_callback') {
      this.chatService
        .handleSlackEvent(body)
        .catch((err: unknown) =>
          this.logger.error('Error handling Slack event', String(err)),
        );
    }

    return { ok: true };
  }
}
