import { tool, generateText } from 'ai';
import { z } from 'zod';

export type MediaToolOptions = {
  /** Custom prompt used when no user prompt is provided */
  defaultPrompt?: string;
};

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
]);

const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
]);

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
};

/** Infer MIME type from URL extension when the server doesn't send Content-Type */
function mimeFromUrl(url: string): string | null {
  const clean = url.split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  return ext ? (EXT_TO_MIME[ext] ?? null) : null;
}

/**
 * Factory for the media tool. Pass the same model instance used by the caller
 * so analysis runs through the same gateway/provider.
 *
 * @example
 * const tools = {
 *   media: createMediaTool(this.gateway(modelId)),
 * };
 */
export function createMediaTool(
  /** A Vercel AI SDK LanguageModelV1 – i.e. gateway(modelId) */
  model: Parameters<typeof generateText>[0]['model'],
  options: MediaToolOptions = {},
) {
  return tool({
    description: [
      'Fetch and analyze a file at a URL.',
      'Use when the user provides a URL to an image, PDF, or document and wants its contents described, read, or extracted.',
      'Supported formats: images (JPEG, PNG, GIF, WebP, SVG, BMP), PDFs, plain text, CSV, Markdown, HTML.',
      'Returns a detailed analysis produced by the vision/document model.',
    ].join(' '),

    inputSchema: z.object({
      url: z.string().url().describe('Public URL of the image, PDF, or file.'),
      prompt: z
        .string()
        .optional()
        .describe(
          'What to do with the file – e.g. "describe the image", "extract all text", "summarize the PDF". Defaults to a thorough general analysis.',
        ),
    }),

    execute: async ({ url, prompt }) => {
      // ── 1. Fetch ──────────────────────────────────────────────────────────
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { 'User-Agent': 'DepotAi-MediaTool/1.0' },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err: any) {
        return {
          error: `Could not fetch URL: ${err?.message ?? 'network error'}`,
        };
      }

      if (!response.ok) {
        return {
          error: `URL responded with ${response.status} ${response.statusText}`,
        };
      }

      // ── 2. Resolve MIME type ──────────────────────────────────────────────
      const contentType = response.headers.get('content-type') ?? '';
      const mimeType =
        contentType.split(';')[0].trim() ||
        mimeFromUrl(url) ||
        'application/octet-stream';

      const analysisPrompt =
        prompt ??
        options.defaultPrompt ??
        'Analyze this file thoroughly. For images, describe everything you see in detail. ' +
          'For documents, summarize the content and extract key information.';

      // ── 3. Plain-text shortcut (no vision call needed) ───────────────────
      if (
        mimeType === 'text/plain' ||
        mimeType === 'text/csv' ||
        mimeType === 'text/markdown'
      ) {
        const text = await response.text();
        const truncated = text.length > 8_000;
        return {
          mimeType,
          url,
          content: text.slice(0, 8_000),
          ...(truncated && {
            note: `Content truncated to 8 000 chars (full size: ${text.length})`,
          }),
        };
      }

      // ── 4. Guard unsupported types ────────────────────────────────────────
      if (!IMAGE_TYPES.has(mimeType) && !DOCUMENT_TYPES.has(mimeType)) {
        return {
          error:
            `Unsupported file type "${mimeType}". ` +
            'Supported: JPEG, PNG, GIF, WebP, SVG, BMP, PDF, TXT, CSV, Markdown, HTML.',
        };
      }

      // ── 5. Read binary ────────────────────────────────────────────────────
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // ── 6. Build multimodal content part ─────────────────────────────────
      // Note: ai v6 ImagePart uses `mimeType`, FilePart uses `mediaType`
      const mediaPart = IMAGE_TYPES.has(mimeType)
        ? ({ type: 'image' as const, image: bytes, mimeType } as const)
        : ({
            type: 'file' as const,
            data: bytes,
            mediaType: mimeType,
          } as const);

      // ── 7. Analyse via vision/document model ──────────────────────────────
      try {
        const result = await generateText({
          model,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: analysisPrompt }, mediaPart],
            },
          ],
        });

        return { analysis: result.text, mimeType, url };
      } catch (err: any) {
        return {
          error: `Model could not analyze this file: ${err?.message ?? 'unknown error'}`,
          mimeType,
          url,
        };
      }
    },
  });
}
