import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ENRICHABLE_FIELDS } from './enrichment.constants';
import { EnrichmentPolicyService } from './enrichment.policy';
import type { MissingFieldCandidate } from './enrichment.types';
import { EnrichmentContextService } from './enrichment.context.service';

@Injectable()
export class EnrichmentScannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: EnrichmentPolicyService,
    private readonly context: EnrichmentContextService,
  ) {}

  async scanCatalogCoreMissingFields(
    limitPerEntity = 100,
  ): Promise<MissingFieldCandidate[]> {
    const results: MissingFieldCandidate[] = [];
    const ctx = await this.context.getContext();
    const cursor = ctx.scanCursor ?? {};

    const products = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "products"
      WHERE ${cursor.productsUpdatedAt ?? '1970-01-01T00:00:00.000Z'}::timestamp <= "updated_at"
      ORDER BY "updated_at" ASC
      LIMIT ${limitPerEntity}
    `;
    for (const p of products) {
      const missing = this.computeMissingFields('products', p);
      if (missing.length > 0) {
        results.push({
          entity: 'products',
          recordId: String(p.id),
          missingFields: missing,
        });
      }
    }

    const variants = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "product_variants"
      WHERE ${cursor.productVariantsUpdatedAt ?? '1970-01-01T00:00:00.000Z'}::timestamp <= "updated_at"
      ORDER BY "updated_at" ASC
      LIMIT ${limitPerEntity}
    `;
    for (const v of variants) {
      const missing = this.computeMissingFields('product_variants', v);
      if (missing.length > 0) {
        results.push({
          entity: 'product_variants',
          recordId: String(v.id),
          missingFields: missing,
        });
      }
    }

    const brands = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "brands"
      WHERE ${cursor.brandsUpdatedAt ?? '1970-01-01T00:00:00.000Z'}::timestamp <= "updated_at"
      ORDER BY "updated_at" ASC
      LIMIT ${limitPerEntity}
    `;
    for (const b of brands) {
      const missing = this.computeMissingFields('brands', b);
      if (missing.length > 0) {
        results.push({
          entity: 'brands',
          recordId: String(b.id),
          missingFields: missing,
        });
      }
    }

    const categories = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "categories"
      WHERE ${cursor.categoriesUpdatedAt ?? '1970-01-01T00:00:00.000Z'}::timestamp <= "updated_at"
      ORDER BY "updated_at" ASC
      LIMIT ${limitPerEntity}
    `;
    for (const c of categories) {
      const missing = this.computeMissingFields('categories', c);
      if (missing.length > 0) {
        results.push({
          entity: 'categories',
          recordId: String(c.id),
          missingFields: missing,
        });
      }
    }

    await this.context.patchContext({
      scanCursor: {
        productsUpdatedAt: this.maxUpdatedAt(products),
        productVariantsUpdatedAt: this.maxUpdatedAt(variants),
        brandsUpdatedAt: this.maxUpdatedAt(brands),
        categoriesUpdatedAt: this.maxUpdatedAt(categories),
      },
    });

    return results;
  }

  private computeMissingFields(
    entity: keyof typeof ENRICHABLE_FIELDS,
    record: Record<string, unknown>,
  ): string[] {
    return ENRICHABLE_FIELDS[entity].filter((field) => {
      if (this.policy.isFieldProtected(entity, field)) return false;

      const value = record[field];
      if (value == null) return true;
      if (typeof value === 'string' && value.trim().length === 0) return true;
      if (Array.isArray(value) && value.length === 0) return true;
      return false;
    });
  }

  private maxUpdatedAt(records: Array<Record<string, unknown>>): string {
    const timestamps = records
      .map((r) => r.updated_at)
      .filter(Boolean)
      .map((v) => new Date(String(v)).toISOString());
    if (timestamps.length === 0) return new Date(0).toISOString();
    return timestamps.sort().at(-1) ?? new Date(0).toISOString();
  }
}
