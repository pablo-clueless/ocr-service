import type { Capability, DocumentInput, MimeGroup, OcrProvider, RecognizedDocument, RecognizeOptions } from "./types";

/**
 * Pass-through provider for plain-text / markdown uploads — the buffer already
 * is the canonical text, so there's nothing to OCR. Keeps the `text` mime group
 * inside the same provider abstraction as everything else.
 */
export class PlainTextProvider implements OcrProvider {
  readonly name = "plain-text";
  readonly accepts: readonly MimeGroup[] = ["text"];
  readonly capabilities: readonly Capability[] = ["text"];

  async recognize(input: DocumentInput, _opts: RecognizeOptions): Promise<RecognizedDocument> {
    const start = Date.now();
    const markdown = input.buffer.toString("utf8").trim();
    return {
      markdown,
      plainText: markdown,
      pages: [{ page: 1, markdown }],
      blocks: [],
      pageCount: 1,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }
}
