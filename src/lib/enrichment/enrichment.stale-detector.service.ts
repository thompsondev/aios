import { Injectable } from '@nestjs/common';

@Injectable()
export class EnrichmentStaleDetectorService {
  isStale(record: Record<string, unknown>, maxAgeDays = 30): boolean {
    const updatedAt = record.updated_at;
    if (!updatedAt) return true;

    const ts = new Date(String(updatedAt)).getTime();
    if (Number.isNaN(ts)) return true;

    const ageMs = Date.now() - ts;
    return ageMs >= maxAgeDays * 24 * 60 * 60 * 1000;
  }
}
