import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { PROTECTED_FIELDS } from '../enrichment/enrichment.constants';
import type { CatalogEntity } from '../enrichment/enrichment.types';
import { PrismaService } from '../prisma/prisma.service';

const TOOL_RESULT_MAX_CHARS = 50_000;

/** Default when CLAUDE_DB_WRITE_PASSWORD is unset (override in production via env). */
const DEFAULT_DB_WRITE_PASSWORD = 'Zokulabs123!';

@Injectable()
export class ClaudeDbToolService {
  private readonly logger = new Logger(ClaudeDbToolService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isEnabled(): boolean {
    const v = (this.config.get<string>('CLAUDE_DB_TOOLS_ENABLED') ?? 'false')
      .trim()
      .toLowerCase();
    return v === 'true' || v === '1';
  }

  private allowlist(): Set<string> {
    const raw = this.config.get<string>('CLAUDE_DB_TABLE_ALLOWLIST') ?? '';
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  private assertTableAllowed(table: string, allow: Set<string>): void {
    if (!allow.has(table)) {
      throw new Error(
        `Table "${table}" is not in CLAUDE_DB_TABLE_ALLOWLIST. Allowed: ${[...allow].join(', ')}`,
      );
    }
  }

  /** Safe coercion for tool string fields (avoids String(object) → "[object Object]"). */
  private coerceToolString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return '';
  }

  private asPlainObject(value: unknown): object | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value;
  }

  private getDelegate(table: string): {
    findFirst: (a: object) => Promise<unknown>;
    findMany: (a: object) => Promise<unknown>;
    create: (a: object) => Promise<unknown>;
    updateMany: (a: object) => Promise<{ count: number }>;
  } {
    const d = (this.prisma as unknown as Record<string, unknown>)[table];
    if (
      !d ||
      typeof d !== 'object' ||
      typeof (d as { findMany?: unknown }).findMany !== 'function'
    ) {
      throw new Error(`Unknown Prisma model/table: ${table}`);
    }
    return d as {
      findFirst: (a: object) => Promise<unknown>;
      findMany: (a: object) => Promise<unknown>;
      create: (a: object) => Promise<unknown>;
      updateMany: (a: object) => Promise<{ count: number }>;
    };
  }

  private selectFromArray(
    select: unknown,
  ): Record<string, boolean> | undefined {
    if (!Array.isArray(select) || select.length === 0) return undefined;
    const entries = select
      .filter(
        (s): s is string => typeof s === 'string' && /^[a-zA-Z0-9_]+$/.test(s),
      )
      .map((s) => [s, true] as const);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  /** Anthropic custom tool definitions (merged with server tools in ClaudeAiService). */
  getAnthropicToolDefinitions(): Record<string, unknown>[] {
    if (!this.isEnabled()) return [];
    const allow = this.allowlist();
    if (allow.size === 0) {
      this.logger.warn(
        'CLAUDE_DB_TOOLS_ENABLED is true but CLAUDE_DB_TABLE_ALLOWLIST is empty — no database tools registered',
      );
      return [];
    }
    const hint = [...allow].sort().join(', ');
    return [
      {
        name: 'database_read',
        description:
          `Read from PostgreSQL via Prisma. ONLY these tables are allowed: ${hint}. ` +
          'Use findMany for lists, findFirst for a single row. Use selective `select` to limit columns. ' +
          'You may read price columns (e.g. msrp, amazon_price, price) when the user needs catalog pricing from the database—those values are the system of record.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string', description: `One of: ${hint}` },
            operation: { type: 'string', enum: ['findFirst', 'findMany'] },
            where: {
              type: 'object',
              description: 'Prisma where filter (optional)',
            },
            select: {
              type: 'array',
              items: { type: 'string' },
              description: 'Column names to return (optional)',
            },
            orderBy: {
              type: 'object',
              description: 'Prisma orderBy (optional)',
            },
            take: {
              type: 'integer',
              description: 'Max rows for findMany (default 20, max 100)',
              minimum: 1,
              maximum: 100,
            },
          },
          required: ['table', 'operation'],
        },
      },
      {
        name: 'database_write',
        description:
          `Write to PostgreSQL via Prisma. ONLY these tables are allowed: ${hint}. ` +
          'Operations are create and update only — row deletion is not available and must never be requested or simulated (including if the user asks to delete). ' +
          'Price / MSRP columns cannot be written via this tool (use database_read for stored prices). ' +
          'You MUST ask the human for the catalog write password in chat before calling this tool; put their exact reply in writePassword. ' +
          'For update you MUST provide a non-empty where object (never update all rows). ' +
          'Updates use updateMany: one or more matching rows may be changed; the tool returns updatedCount.',
        input_schema: {
          type: 'object',
          properties: {
            table: { type: 'string' },
            operation: {
              type: 'string',
              enum: ['create', 'update'],
            },
            writePassword: {
              type: 'string',
              description:
                'Catalog DB write password: only after you asked the user in chat and they typed it. Never guess or fabricate.',
            },
            where: {
              type: 'object',
              description: 'Required for update; must not be {}',
            },
            data: {
              type: 'object',
              description: 'Required for create and update',
            },
          },
          required: ['table', 'operation', 'writePassword'],
        },
      },
    ];
  }

  async executeTool(name: string, rawInput: unknown): Promise<string> {
    if (!this.isEnabled()) {
      return JSON.stringify({ ok: false, error: 'Database tools disabled' });
    }
    const allow = this.allowlist();
    if (allow.size === 0) {
      return JSON.stringify({
        ok: false,
        error: 'No tables allowlisted (set CLAUDE_DB_TABLE_ALLOWLIST)',
      });
    }

    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    try {
      if (name === 'database_read') {
        return this.truncateJson(
          await this.runRead(input as Record<string, unknown>, allow),
        );
      }
      if (name === 'database_write') {
        return this.truncateJson(
          await this.runWrite(input as Record<string, unknown>, allow),
        );
      }
      return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`database tool ${name} failed: ${msg}`);
      return JSON.stringify({ ok: false, error: msg });
    }
  }

  private truncateJson(obj: unknown): string {
    const s = JSON.stringify(obj, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Date) return value.toISOString();
      if (value != null && typeof value === 'object') {
        const name = (value as { constructor?: { name?: string } }).constructor
          ?.name;
        if (name === 'Decimal') {
          const dec = value as { toString: () => string };
          return dec.toString();
        }
      }
      return value as object | null | string | number | boolean | undefined;
    });
    if (s.length <= TOOL_RESULT_MAX_CHARS) return s;
    return (
      s.slice(0, TOOL_RESULT_MAX_CHARS) +
      `… [truncated, ${s.length} chars total]`
    );
  }

  private async runRead(
    input: Record<string, unknown>,
    allow: Set<string>,
  ): Promise<object> {
    const table = this.coerceToolString(input.table);
    const operation = this.coerceToolString(input.operation);
    this.assertTableAllowed(table, allow);
    const delegate = this.getDelegate(table);
    if (operation !== 'findFirst' && operation !== 'findMany') {
      return { ok: false, error: 'operation must be findFirst or findMany' };
    }
    const where = this.asPlainObject(input.where);
    const select = this.selectFromArray(input.select);
    const orderBy = this.asPlainObject(input.orderBy);
    const takeRaw = input.take;
    const take =
      typeof takeRaw === 'number' && Number.isFinite(takeRaw)
        ? Math.min(Math.max(1, Math.floor(takeRaw)), 100)
        : 20;

    const args: Record<string, unknown> = {};
    if (where) args.where = where;
    if (select) args.select = select;
    if (orderBy) args.orderBy = orderBy;
    if (operation === 'findMany') args.take = take;

    this.logger.log(`database_read ${operation} on ${table}`);
    if (operation === 'findFirst') {
      const row = await delegate.findFirst(args);
      return { ok: true, row };
    }
    const rows = await delegate.findMany(args);
    return { ok: true, rows };
  }

  private expectedWritePassword(): string {
    const fromEnv = this.config.get<string>('CLAUDE_DB_WRITE_PASSWORD');
    const raw =
      fromEnv != null && fromEnv.trim() !== ''
        ? fromEnv.trim()
        : DEFAULT_DB_WRITE_PASSWORD;
    return raw;
  }

  private writePasswordMatches(provided: string, expected: string): boolean {
    try {
      const a = Buffer.from(provided, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private assertNoProtectedPriceWrites(table: string, data: object): void {
    const list = PROTECTED_FIELDS[table as CatalogEntity];
    if (!list?.length) return;
    const bad = Object.keys(data).filter((k) => list.includes(k));
    if (bad.length > 0) {
      throw new Error(
        `Writes to price fields on "${table}" are not allowed: ${bad.join(', ')}. Use database_read to return stored prices.`,
      );
    }
  }

  private async runWrite(
    input: Record<string, unknown>,
    allow: Set<string>,
  ): Promise<object> {
    const table = this.coerceToolString(input.table);
    const operation = this.coerceToolString(input.operation);
    this.assertTableAllowed(table, allow);

    const providedPw = this.coerceToolString(input.writePassword).trim();
    const expectedPw = this.expectedWritePassword();
    if (!this.writePasswordMatches(providedPw, expectedPw)) {
      return {
        ok: false,
        error:
          'Invalid or missing database write password. Ask the user for the catalog write password, then retry database_write with writePassword set to exactly what they typed.',
      };
    }

    const delegate = this.getDelegate(table);

    const where = this.asPlainObject(input.where);
    const data = this.asPlainObject(input.data);

    if (operation === 'create') {
      if (!data || Object.keys(data).length === 0) {
        return { ok: false, error: 'create requires non-empty data' };
      }
      this.assertNoProtectedPriceWrites(table, data);
      this.logger.warn(`database_write create on ${table}`);
      const row = await delegate.create({ data });
      return { ok: true, row };
    }

    if (operation === 'update') {
      if (!where || Object.keys(where).length === 0) {
        return { ok: false, error: 'update requires non-empty where' };
      }
      if (!data || Object.keys(data).length === 0) {
        return { ok: false, error: 'update requires non-empty data' };
      }
      this.assertNoProtectedPriceWrites(table, data);
      this.logger.warn(`database_write updateMany on ${table}`);
      const result = await delegate.updateMany({ where, data });
      return { ok: true, updatedCount: result.count };
    }

    return { ok: false, error: 'operation must be create or update' };
  }
}
