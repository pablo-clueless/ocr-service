import TurndownService from "turndown";
import mammoth from "mammoth";

import type { Capability, DocumentInput, MimeGroup, OcrProvider, RecognizedDocument, RecognizeOptions } from "./types";

/**
 * DOCX extraction. Goes DOCX → HTML → markdown via `turndown` (not
 * `extractRawText`) so headings, lists and tables survive and the downstream
 * prompt sees the same canonical markdown as every other provider.
 */
export class MammothProvider implements OcrProvider {
  readonly name = "mammoth";
  readonly accepts: readonly MimeGroup[] = ["docx"];
  readonly capabilities: readonly Capability[] = ["text", "tables"];

  private readonly turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  async recognize(input: DocumentInput, _opts: RecognizeOptions): Promise<RecognizedDocument> {
    const start = Date.now();
    const { value: html } = await mammoth.convertToHtml({ buffer: input.buffer });
    const markdown = this.turndown.turndown(html).trim();
    const plainText = htmlToText(html);

    return {
      markdown,
      plainText,
      pages: [{ page: 1, markdown }],
      blocks: [],
      pageCount: 1,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }
}

/** DOCX has no page concept here; strip tags for a plain-text rendering. */
const htmlToText = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
