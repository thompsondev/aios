import { Injectable } from '@nestjs/common';
import type { SourceCandidate } from './enrichment.types';

@Injectable()
export class EnrichmentScraperFetcherService {
  async fetchCandidates(query: string): Promise<SourceCandidate[]> {
    // Phase 3 lightweight fetcher scaffold:
    // return domain-prioritized synthetic candidates from query intent.
    // In production, replace with dedicated search provider fetch pipeline.
    const q = encodeURIComponent(query);
    return [
      {
        domain: 'amazon.com',
        url: `https://www.amazon.com/s?k=${q}`,
        snippet: 'Retail listing context',
      },
      {
        domain: 'bestbuy.com',
        url: `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`,
        snippet: 'Retail listing context',
      },
      {
        domain: 'cdw.com',
        url: `https://www.cdw.com/search/?key=${q}`,
        snippet: 'Distributor listing context',
      },
    ];
  }
}
