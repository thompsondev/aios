import type { CatalogEntity } from './enrichment.types';

export const ENRICHMENT_CONTEXT_KEY = 'enrichment:catalog-core:context:v1';

/** true / 1 / yes (case-insensitive); unset or empty → defaultValue. */
export function parseEnvBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return defaultValue;
  return v === 'true' || v === '1' || v === 'yes';
}

export const TRUSTED_DOMAINS: string[] = [
  'apple.com',
  'samsung.com',
  'google.com',
  'amazon.com',
  'bestbuy.com',
  'cdw.com',
  'keepa.com',
];

// Hard guard: price fields are always protected and never updated by AI enrichment.
export const PROTECTED_FIELDS: Record<CatalogEntity, string[]> = {
  products: ['msrp', 'amazon_price'],
  product_variants: ['price', 'msrp'],
  brands: [],
  categories: [],
};

// Only these fields are eligible for the enrichment pipeline (chat-driven or worker).
export const ENRICHABLE_FIELDS: Record<CatalogEntity, string[]> = {
  products: [
    'description',
    'short_description',
    'image_url',
    'model_number',
    'release_date',
    'dimensions',
    'weight',
    'weight_used',
    'weight_new',
    'specs',
    'seo_keyword',
    'seo_description',
    'seo_title',
    'seo_schema',
    'seo_faq_schema',
    'asin',
    'amazon_url',
  ],
  product_variants: [
    'image_url',
    'connectivity',
    'cellular_network',
    'mpn',
    'specs',
  ],
  brands: ['logo_url', 'description', 'website'],
  categories: [
    'description',
    'image_url',
    'meta_title',
    'meta_description',
    'body_text',
    'og_image',
    'lookup_keys',
    'banner_image_url',
    'banner_headline',
    'banner_subheadline',
  ],
};
