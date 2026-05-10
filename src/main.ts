import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { ConfigService } from '@nestjs/config';
import * as moment from 'moment-timezone';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as express from 'express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { AllExceptionsFilter } from './middleware';
import { CustomLoggerService } from './lib/loggger/logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const productionUrl = configService.get<string>('PRODUCTION_URL');
  const developmentUrl = configService.get<string>('DEVELOPMENT_URL');
  const platform =
    configService.get<string>('PLATFORM_NAME')?.trim() || 'DepotAi';
  const logger = app.get(CustomLoggerService);
  const apiKeyEnabled = !!configService.get<string>('API_KEY');
  const domainChatRaw = configService.get<string>('DOMAIN_CHAT');
  const domainChatSet = domainChatRaw
    ? new Set(
        domainChatRaw
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      )
    : null;
  const unlimitedPrompts = !domainChatSet?.size;
  const authorName = configService.get<string>('AUTHOR_NAME');
  const authorUrl = configService.get<string>('AUTHOR_URL');

  // Capture raw body for Slack request-signature verification.
  // Must be registered BEFORE express.json() so the stream is still unconsumed.
  app.use(
    '/v1/chat/slack/events',
    (req: any, _res: express.Response, next: express.NextFunction) => {
      let rawBody = '';
      req.on('data', (chunk: Buffer) => {
        rawBody += chunk.toString('utf8');
      });
      req.on('end', () => {
        req.rawBody = rawBody;
        try {
          req.body = JSON.parse(rawBody);
        } catch {
          req.body = {};
        }
        next();
      });
    },
  );

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  const expressApp = app.getHttpAdapter().getInstance() as express.Application;
  expressApp.use(express.static('public'));

  app.setGlobalPrefix('v1');

  app.use(
    helmet({
      contentSecurityPolicy: false, // Scalar API docs require inline scripts
    }),
  );

  moment.tz.setDefault('Africa/Lagos');

  expressApp.set('trust proxy', 1);

  app.useGlobalFilters(new AllExceptionsFilter(logger));

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5000,
    }),
  );

  const allowedOrigins = [/^http:\/\/localhost:\d+$/];
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    optionsSuccessStatus: 200,
    methods: 'GET,PATCH,POST,PUT,DELETE,OPTIONS',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      stopAtFirstError: true,
      transform: true,
      whitelist: false,
    }),
  );

  const swaggerOptions = new DocumentBuilder()
    .setTitle(`${platform} API`)
    .setDescription(`API Documentation for ${platform} API`)
    .setVersion('1.0.0')
    .addServer(`http://localhost:${port}`, 'Local environment')
    .addServer(`https://${developmentUrl}`, 'Development environment')
    .addServer(`https://${productionUrl}`, 'Production environment')
    .addBearerAuth(
      { type: 'http', scheme: 'Bearer', bearerFormat: 'JWT' },
      'Authorization',
    )
    .addTag('Server', 'Endpoint for Server functions')
    .addTag('Chat', 'Endpoint for Chat functions')
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerOptions);
  expressApp.get('/v1/docs-json', (_req, res) => res.json(swaggerDocument));
  SwaggerModule.setup('v1/swagger', app, swaggerDocument);
  expressApp.use(
    '/v1/docs',
    apiReference({
      spec: { url: '/v1/docs-json' },
      theme: 'default',
      pageTitle: `${platform} API`,
    }),
  );

  const aiModelRaw = configService.get<string>('AI_MODEL')?.trim();
  const aiModel =
    aiModelRaw && aiModelRaw.length > 0 ? aiModelRaw : 'openai/gpt-4o-mini';

  try {
    await app.listen(port);
    const baseUrl = `http://localhost:${port}`;
    console.log(`Server running at ${baseUrl}`);
    console.log(`AI model: ${aiModel}`);
    console.log(`Scalar: ${baseUrl}/v1/docs`);
    console.log(`Swagger: ${baseUrl}/v1/swagger`);
    console.log(
      `API Key Auth: ${apiKeyEnabled ? 'ENABLED (x-api-key header required)' : 'DISABLED (open access)'}`,
    );
    console.log(`Unlimited prompts: ${unlimitedPrompts}`);
    console.log(`Copyright: ${authorName ? 'enabled' : 'disabled'}`);
  } catch (err) {
    console.error('Error starting server', err);
  }
}
bootstrap();
