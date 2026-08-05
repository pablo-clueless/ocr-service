import { PDFParse } from "pdf-parse";

import type {
  Capability,
  DocumentInput,
  MimeGroup,
  OcrProvider,
  PageResult,
  RecognizedDocument,
  RecognizeOptions,
} from "./types";

/**
 * pdf-parse text-layer extraction. Returns `blocks: []` — it has no geometry.
 * The router only picks this for `text`-only functions and applies the per-page
 * scanned-PDF heuristic before trusting its output.
 */
export class PdfTextProvider implements OcrProvider {
  readonly name = "pdf-text";
  readonly accepts: readonly MimeGroup[] = ["pdf"];
  readonly capabilities: readonly Capability[] = ["text"];

  async recognize(input: DocumentInput, opts: RecognizeOptions): Promise<RecognizedDocument> {
    const start = Date.now();
    const parser = new PDFParse({ data: input.buffer });

    try {
      // A page range maps to pdf-parse's inclusive first..last window.
      const params = opts.pageRange ? { first: opts.pageRange[0], last: opts.pageRange[1] } : undefined;
      const result = await parser.getText(params);

      const pages: PageResult[] = result.pages.map((p) => ({ page: p.num, markdown: p.text }));
      const markdown = result.text.trim();

      return {
        markdown,
        plainText: markdown,
        pages,
        blocks: [],
        pageCount: result.total,
        provider: this.name,
        durationMs: Date.now() - start,
      };
    } finally {
      await parser.destroy();
    }
  }
}
