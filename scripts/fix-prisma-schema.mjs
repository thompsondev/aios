import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const schemaPath = resolve(process.cwd(), 'prisma/schema.prisma');
const before = readFileSync(schemaPath, 'utf8');

const target =
  '@unique(map: "IDX_product_variants_mpn", where: raw("(mpn IS NOT NULL)"))';
const replacement = '@unique(map: "IDX_product_variants_mpn")';

const after = before.replaceAll(target, replacement);

if (after !== before) {
  writeFileSync(schemaPath, after, 'utf8');
  console.log('[fix-prisma-schema] Patched unsupported partial unique clause.');
} else {
  console.log('[fix-prisma-schema] No changes needed.');
}
