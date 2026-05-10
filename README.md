# DepotAi

A NestJS API backend for **DepotAi**: product research, catalog enrichment, and an AI assistant powered primarily by **Anthropic Claude** (with optional native web search/fetch when enabled). Data lives in **PostgreSQL** via **Prisma**. Branding defaults to DepotAi; adjust env (`PLATFORM_NAME`, demo UI) as needed.

## Features

- **AI chat endpoint** – `POST /v1/chat/prompt` returns a complete AI-generated text response
- **Streaming endpoint** – `POST /v1/chat/prompt/stream` streams the AI response as SSE (`text/event-stream`); emits `searching` → `search_done` → `text` delta events → `done`
- **Optional web context** – Claude server tools (web search / web fetch) when enabled in Anthropic Console and env; legacy Valyu pre-search may be documented in older branches
- **Configurable AI** – `CLAUDE_API_KEY`, `CLAUDE_MODEL`, and related env vars; see `.env.example`
- **Optional API key auth** – Set `API_KEY` in env to require an `x-api-key` header on all routes; omit for open access. When open access: only domains listed in `DOMAIN_CHAT` (one or more, comma-separated) have a per-day-per-IP limit (default **5**, or `PROMPTS_PER_DAY_CHAT`); all other domains are **unlimited**. Omit `DOMAIN_CHAT` for unlimited prompts everywhere.
- **WhatsApp bot** – Connect a WhatsApp Cloud API app to receive and reply to messages; per-user conversation history stored in Redis; read receipts and typing indicators
- **Slack bot** – Connect a Slack app to receive and reply to `app_mention` and direct messages; per-user conversation history stored in Redis; request signature verification; event deduplication
- **Demo page** – Root URL serves a streaming chat UI (`public/index.html`): prompt box, Enter to send, Shift+Enter for new line, paste-to-attachment for long text
- **API docs** – [Scalar](https://scalar.com/) API reference at `/v1/docs` with configurable servers and Bearer auth
- **Security** – Helmet, rate limiting, CORS, global validation pipe, and a custom exception filter
- **Database** – PostgreSQL with Prisma (migrations, generate, seed, Studio)
- **Logging** – Custom logger service; timezone set to Africa/Lagos

## Tech stack

- [NestJS](https://nestjs.com/) 11
- [Prisma](https://www.prisma.io/) 7 (PostgreSQL)
- [Anthropic Claude](https://www.anthropic.com/) (Messages API via `@anthropic-ai/sdk`)
- [Scalar](https://scalar.com/) + [NestJS Swagger](https://docs.nestjs.com/openapi/introduction) (OpenAPI)
- TypeScript, class-validator, class-transformer, Winston

## Prerequisites

- **Node.js** 18+
- **pnpm** (recommended) or npm/yarn
- **PostgreSQL** (local or remote)
- **Anthropic API key** (`CLAUDE_API_KEY`) for Claude

## Project setup

```bash
pnpm install
```

## Environment variables

Copy the example file and set your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/depotai`) |
| `CLAUDE_API_KEY` | Yes* | Anthropic API key for chat and tools (*required for AI routes unless you only use non-AI endpoints) |
| `CLAUDE_MODEL` | No | Claude model id (default: `claude-sonnet-4-6`) |
| `CLAUDE_DB_TOOLS_ENABLED` | No | Set `true` with `CLAUDE_DB_TABLE_ALLOWLIST` to expose read/write DB tools to the model |
| `CLAUDE_DB_TABLE_ALLOWLIST` | No | Comma-separated Prisma model names allowed for DB tools (e.g. `products,product_variants`) |
| `CLAUDE_DB_WRITE_PASSWORD` | No | Secret the user must type in chat before `database_write` runs. If unset, a built-in default applies (override in production) |
| `PORT` | No | Server port (default: `3000`) |
| `API_KEY` | No | If set, all routes require an `x-api-key: <value>` header. Omit or leave blank for open access. |
| `DOMAIN_CHAT` | No | When `API_KEY` is not set: comma-separated list of hostnames that get a per-day-per-IP limit (request `Host` must match one). Only these domains are limited; all other domains are **unlimited**. Omit for unlimited everywhere. |
| `PROMPTS_PER_DAY_CHAT` | No | For domains listed in `DOMAIN_CHAT`, this many prompts per day per IP (default **5**). Ignored if `DOMAIN_CHAT` is not set. |
| `PLATFORM_NAME` | No | Name used in API docs title (e.g. your product name) |
| `PLATFORM_URL` | No | Main app URL (for API docs). Also used for branding: copyright is shown on localhost and when the request host is the same as or a subdomain of this URL’s host; otherwise it is hidden. |
| `DEVELOPMENT_URL` | No | Dev server host (for API docs) |
| `PRODUCTION_URL` | No | Production host (for API docs) |
| `AUTHOR_NAME` | No | Author handle shown in the demo UI header ("by X") and footer when the request is from `PLATFORM_URL` or a subdomain; omit to hide both |
| `AUTHOR_URL` | No | URL for the footer author link; only used when `AUTHOR_NAME` is set and branding is shown |
| `CORS_ORIGINS` | No | Comma-separated list of extra allowed origins (e.g. `https://app.com,https://other.com`). All `http(s)://localhost` and `http(s)://127.0.0.1` ports are always allowed by default. |
| `SLACK_BOT_TOKEN` | No | Slack bot OAuth token (starts with `xoxb-`). Required for the Slack bot to send messages. |
| `SLACK_SIGNING_SECRET` | No | Slack app signing secret. Used to verify that incoming webhook requests originate from Slack. Verification is skipped when unset (not recommended in production). |
| `SLACK_CLIENT_ID` | No | Slack app client ID (found in Basic Information). Required for the install redirect and OAuth callback. |
| `SLACK_CLIENT_SECRET` | No | Slack app client secret (found in Basic Information). Required to handle the OAuth install callback. |
| `SLACK_SCOPES` | No | Comma-separated bot scopes to request during install (e.g. `app_mentions:read,chat:write,im:history`). Used by the `/v1/chat/slack/add` install redirect. |
| `WHATSAPP_CLOUD_API_VERSION` | No | WhatsApp Cloud API version (e.g. `v17.0`). Required for the WhatsApp bot. |
| `WHATSAPP_CLOUD_API_PHONE_NUMBER_ID` | No | Phone number ID from your Meta app dashboard. Required for the WhatsApp bot. |
| `WHATSAPP_CLOUD_API_ACCESS_TOKEN` | No | Permanent or temporary access token from your Meta app. Required for the WhatsApp bot. |
| `WHATSAPP_CLOUD_API_WEBHOOK_VERIFICATION_TOKEN` | No | Token you define and enter in the Meta webhook config to verify the subscription challenge. |

## Database

Generate the Prisma client and run migrations:

```bash
# Apply migrations and generate client
pnpm prisma migrate deploy
pnpm prisma generate

# Optional: seed (current seed is a no-op placeholder)
pnpm run seed
```

For local development with migration creation and Studio:

```bash
pnpm run prisma:dev
```

## Run the project

```bash
# Development (watch mode)
pnpm run start:dev

# Production build and run (includes migrate, generate, seed, then nest build)
pnpm run build
pnpm run start:prod
```

- **App / demo UI**: `http://localhost:3000` (streaming chat page)
- **API**: `http://localhost:3000/v1` (all API routes use the `v1` prefix)
- **API docs (Scalar)**: `http://localhost:3000/v1/docs`

On startup the server logs `Unlimited prompts: true/false` and `Copyright: enabled/disabled` (enabled when `AUTHOR_NAME` is set; copyright is always shown on localhost and on `PLATFORM_URL` or its subdomains).

## Run tests

```bash
# Unit tests
pnpm run test

# E2E tests
pnpm run test:e2e

# Coverage
pnpm run test:cov
```

## API overview

- **Server** – `GET /v1` – Health / hello
- **Branding** – `GET /v1/branding` – Returns `{ authorName, authorUrl }` on localhost or when the request host is the same as or a subdomain of `PLATFORM_URL`; otherwise returns nulls (copyright hidden). Used by the demo UI to hydrate the header and footer.
- **Chat** – `POST /v1/chat/prompt` – Body: `{ "prompt": "string" }` – Returns a complete AI-generated text response
- **Chat (stream)** – `POST /v1/chat/prompt/stream` – Body: `{ "prompt": "string" }` – Streams the response as `text/event-stream` SSE
- **WhatsApp** – `GET /v1/chat/webhook` – Webhook verification challenge (Meta subscription setup)
- **WhatsApp** – `POST /v1/chat/webhook` – Incoming WhatsApp messages
- **Slack (install)** – `GET /v1/chat/slack/add` – Redirects to the Slack OAuth install page (scopes driven by `SLACK_CLIENT_ID` + `SLACK_SCOPES` in env)
- **Slack (OAuth callback)** – `GET /v1/chat/slack/events` – Slack OAuth install callback; exchanges the `code` param for an access token after a workspace installs the app
- **Slack (events)** – `POST /v1/chat/slack/events` – Slack Event API webhook; handles `url_verification` and `event_callback` (app_mention, message.im)

### SSE event types (streaming endpoint)

Each event is a JSON object on a `data:` line.

| Event | Fields | Description |
|-------|--------|-------------|
| `searching` | — | Web search phase started (Claude native tools or client tool UI) |
| `search_done` | — | Web search complete; AI generation begins |
| `text` | `v` | Incremental text delta from the model |
| `reasoning` | `v` | Incremental reasoning delta (extended-thinking models) |
| `tool_call` | `tool`, `args` | Model called an internal tool (e.g. `database`) |
| `tool_result` | `tool` | Internal tool returned a result |
| `done` | — | Stream complete |
| `error` | `msg` | Stream-level error |

Full request/response details and auth options are in the API docs at `/v1/docs`.

## Project structure (high level)

```
public/                  # Static assets; root serves index.html (streaming chat UI)
src/
├── app/                 # App module, controller, service
├── lib/                 # Shared libs
│   ├── ai/              # AI service, system prompt (sp.ts)
│   ├── loggger/         # Custom logger
│   ├── prisma/          # Prisma service, seed
│   ├── slack/           # SlackService — send messages, verify request signatures
│   └── whatsapp/        # WhatsappService — send messages, read receipts, typing indicator
├── middleware/          # Exception filter, API key guard, open-access limit guard, decorators
├── modules/
│   └── chat/            # Chat controller & service (prompt, stream, WhatsApp, Slack events)
└── main.ts              # Bootstrap, static files, Scalar API docs, CORS, rate limit
```

To change the assistant’s personality and scope, edit the system prompt in `src/lib/ai/sp.ts`.

## Scripts reference

| Script | Description |
|--------|-------------|
| `pnpm run start` | Start once |
| `pnpm run start:dev` | Start in watch mode |
| `pnpm run start:prod` | Run production build (`node dist/main`) |
| `pnpm run build` | Migrate, generate, seed, then `nest build` |
| `pnpm run prisma:dev` | `migrate dev` + generate + Studio |
| `pnpm run prisma:studio` | Open Prisma Studio |
| `pnpm run seed` | Run Prisma seed script |
| `pnpm run lint` | ESLint with fix |
| `pnpm run format` | Prettier on `src` and `test` |

## WhatsApp bot setup

1. Create a Meta app at [developers.facebook.com](https://developers.facebook.com) and add the **WhatsApp** product.
2. Under **WhatsApp > API Setup**, copy the **Phone Number ID** → `WHATSAPP_CLOUD_API_PHONE_NUMBER_ID` and generate a **Temporary Access Token** (or configure a permanent one via a System User) → `WHATSAPP_CLOUD_API_ACCESS_TOKEN`.
3. Set `WHATSAPP_CLOUD_API_VERSION` to the API version shown in the dashboard (e.g. `v17.0`).
4. Under **WhatsApp > Configuration**, set the webhook URL to `https://<your-host>/v1/chat/webhook`, choose a verify token of your own and set it as `WHATSAPP_CLOUD_API_WEBHOOK_VERIFICATION_TOKEN`, then subscribe to the `messages` field.
5. Restart the server. The bot replies to incoming text messages with per-user conversation history persisted in Redis.

## Slack bot setup

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.

### 2. Get your credentials

- **Basic Information** → copy **Signing Secret** → set as `SLACK_SIGNING_SECRET`
- **Basic Information** → copy **Client ID** → set as `SLACK_CLIENT_ID`
- **Basic Information** → copy **Client Secret** → set as `SLACK_CLIENT_SECRET`
- **OAuth & Permissions** → add bot scope **`chat:write`** → **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`) → set as `SLACK_BOT_TOKEN`

### 3. Expose your server publicly

Slack needs to reach your endpoint. If running locally, use a tunnel:

```bash
npx ngrok http 3000
```

Copy the `https://….ngrok.io` URL.

### 4. Enable Event Subscriptions

In your Slack app → **Event Subscriptions** → toggle **Enable Events** → set Request URL to:

```
https://<your-ngrok-or-domain>/v1/chat/slack/events
```

Slack will immediately send a `url_verification` challenge — the server handles it automatically and Slack will show **Verified**.

Then under **Subscribe to bot events**, add:
- `app_mention` — bot is @mentioned in a channel
- `message.im` — direct messages to the bot

Save changes.

### 5. Enable Direct Messages (App Home)

To allow users to DM the bot directly, go to your Slack app → **App Home** → scroll to **Show Tabs** → enable **Messages Tab** → check **"Allow users to send Slash commands and messages from the messages tab"**.

Without this, users will see *"Sending messages to this app has been turned off"* when they try to DM the bot.

### 6. Invite the bot to a channel

In Slack: `/invite @<your-app-name>` in any channel you want it active in.

### 7. Talk to it

- **In a channel**: `@your-bot-name hello`
- **In DMs**: send a message directly

The bot replies in-thread and remembers conversation history per user (last 20 messages, 7-day TTL via Redis). Slack retries are deduplicated automatically.

### How other users find and chat with the bot

#### Within the same workspace

Anyone already in the workspace can:
- **DM the bot** — search for it by name in the sidebar under **Apps**, or click **+** next to **Direct messages**
- **Mention it in a channel** — `@your-bot-name hello` in any channel it has been invited to

Invite it to more channels with `/invite @your-bot-name`.

#### For users in other workspaces

You have two options:

**Option A — Share an install link (easiest)**

In your Slack app settings → **Manage Distribution** → enable **Distribute App** → set the **Redirect URL** to:

```
https://<your-domain>/v1/chat/slack/events
```

Then share the install link:

```
https://<your-domain>/v1/chat/slack/add
```

Visiting that URL redirects straight to Slack's OAuth page using the `SLACK_CLIENT_ID` and `SLACK_SCOPES` from env. After the user authorizes, Slack redirects back to the callback above which exchanges the code for a token and shows a success page.

Make sure `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SCOPES` are set in env for this to work.

> **Note:** The current implementation uses a single `SLACK_BOT_TOKEN`, so it only sends messages back to the one workspace it was originally installed in. To support multiple workspaces you would need to store each workspace's token after their OAuth install completes.

**Option B — Publish to the Slack App Directory**

Go to **Manage Distribution** → **Submit to App Directory**. Slack reviews and lists it publicly so anyone can discover and install it.

| Goal | What to do |
|------|-----------|
| Same workspace | Search the bot by name → DM or invite to channel |
| Other workspaces (private) | Share the install URL from Manage Distribution |
| Public (anyone) | Submit to Slack App Directory |

## License

This project is [MIT licensed](LICENSE).

## Contributing

Contributions are welcome. Open an issue or a pull request as needed.
