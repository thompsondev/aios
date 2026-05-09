import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentPolicyService } from './enrichment.policy';
import type { CatalogEntity } from './enrichment.types';

@Injectable()
export class EnrichmentDbUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: EnrichmentPolicyService,
  ) {}

  async updateFieldIfMissing(
    entity: CatalogEntity,
    recordId: string,
    field: string,
    value: unknown,
  ): Promise<boolean> {
    this.policy.assertAllowedUpdate(entity, field);
    if (value == null) return false;
    this.assertSqlIdentifier(entity);
    this.assertSqlIdentifier(field);

    const currentRows = await this.prisma.$queryRawUnsafe<
      Array<{ current_value: string | null }>
    >(
      `SELECT "${field}"::text AS current_value FROM "${entity}" WHERE id = $1 LIMIT 1`,
      recordId,
    );
    const currentValue = currentRows[0]?.current_value;
    if (currentValue && String(currentValue).trim().length > 0) {
      return false;
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE "${entity}" SET "${field}" = $1, "updated_at" = NOW() WHERE id = $2`,
      value as any,
      recordId,
    );
    return true;
  }

  private assertSqlIdentifier(value: string): void {
    if (!/^[a-z_]+$/.test(value)) {
      throw new Error(`Invalid SQL identifier: ${value}`);
    }
  }
}
