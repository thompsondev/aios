import { Injectable } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import type { ExtractionOutput, SourceCandidate } from './enrichment.types';

@Injectable()
export class EnrichmentAiExtractorService {
  constructor(private readonly aiService: AiService) {}

  async extractFieldValue(
    entity: string,
    field: string,
    record: Record<string, unknown>,
    sources: SourceCandidate[],
  ): Promise<ExtractionOutput> {
    const prompt = [
      'Extract one field value for catalog enrichment.',
      `Entity: ${entity}`,
      `Field: ${field}`,
      `Record JSON: ${JSON.stringify(record)}`,
      `Candidate sources: ${JSON.stringify(sources)}`,
      'Rules:',
      '- Never infer price data.',
      '- Return valid JSON only with keys: value, rationale, candidates.',
      '- candidates should be an array of { value, sourceUrl } when multiple plausible values exist.',
      '- If uncertain, return {"value": null, "rationale":"uncertain", "candidates":[]}',
    ].join('\n');

    let value: unknown = null;
    let rationale = 'uncertain';
    let candidates: Array<{ value: unknown; sourceUrl?: string }> = [];
    try {
      const text = await this.aiService.generateEnrichmentExtraction(prompt);
      const parsed = JSON.parse(this.extractJson(text));
      value = parsed?.value ?? null;
      rationale = String(parsed?.rationale ?? rationale);
      candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    } catch {
      value = null;
      rationale = 'ai_parse_failed';
      candidates = [];
    }

    return { value, rationale, sources, candidates };
  }

  private extractJson(raw: string): string {
    const s = raw.trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) return s.slice(start, end + 1);
    return s;
  }
}
