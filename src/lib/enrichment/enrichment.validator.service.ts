import { Injectable } from '@nestjs/common';
import type { ValidationResult } from './enrichment.types';

@Injectable()
export class EnrichmentValidatorService {
  validateFieldValue(field: string, value: unknown): ValidationResult {
    if (value == null) {
      return { ok: false, normalizedValue: null, reasons: ['empty_value'] };
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return { ok: false, normalizedValue: null, reasons: ['empty_string'] };
      }

      if (field.includes('url') || field.includes('image')) {
        if (!this.isHttpsUrl(trimmed)) {
          return {
            ok: false,
            normalizedValue: trimmed,
            reasons: ['invalid_url'],
          };
        }
      }

      return { ok: true, normalizedValue: trimmed, reasons: ['valid_string'] };
    }

    if (Array.isArray(value)) {
      return {
        ok: value.length > 0,
        normalizedValue: value,
        reasons: value.length > 0 ? ['valid_array'] : ['empty_array'],
      };
    }

    return { ok: true, normalizedValue: value, reasons: ['valid_value'] };
  }

  private isHttpsUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  }
}
