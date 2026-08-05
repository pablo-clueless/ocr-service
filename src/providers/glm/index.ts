import type { Capability, DocumentInput, MimeGroup, OcrProvider, RecognizedDocument, RecognizeOptions } from "../types";
import { splitPdfToPageImages, mapWithConcurrency, type PageChunk } from "./chunker";
import { GlmClient, type LayoutParsingRequest } from "./client";
import { mapLayoutParsing } from "./mapper";

const DEFAULT_CONCURRENCY = 8;

/**
 * GLM-OCR extraction provider — the layout-aware, seal-capable path. Its
 * standout capability is seal/stamp recognition, which is why
 * SIGNING and stamped Nigerian documents route here. Extraction only; Azure
 * OpenAI stays the interpretation layer.
 */
export class GlmOcrProvider implements OcrProvider {
  readonly name = "glm-ocr";
  readonly accepts: readonly MimeGroup[] = ["pdf", "image"];
  readonly capabilities: readonly Capability[] = ["text", "layout", "tables", "handwriting", "seals"];

  constructor(
    private readonly client: GlmClient,
    private readonly concurrency: number = DEFAULT_CONCURRENCY,
  ) {}

  async recognize(input: DocumentInput, opts: RecognizeOptions): Promise<RecognizedDocument> {
    const start = Date.now();

    // Prefer per-page base64 images: sidesteps the PDF size/page caps and keeps
    // the document out of any external blob store (docs/glm-ocr.md).
    const chunks: PageChunk[] =
      input.mimeGroup === "pdf"
        ? await splitPdfToPageImages(input.buffer, opts.pageRange)
        : [{ page: 1, dataUri: `data:${imageMime(input.buffer)};base64,${input.buffer.toString("base64")}` }];

    const responses = await mapWithConcurrency(chunks, this.concurrency, (chunk) =>
      this.client.layoutParsing(this.buildRequest(chunk, opts), opts.signal),
    );

    return mapLayoutParsing(responses, { provider: this.name, durationMs: Date.now() - start });
  }

  private buildRequest(chunk: PageChunk, opts: RecognizeOptions): LayoutParsingRequest {
    return {
      model: "glm-ocr",
      file: chunk.dataUri,
      ...(opts.returnCropImages ? { return_crop_images: true } : {}),
      // The API constrains these lengths; drop rather than send an invalid value.
      ...(inRange(opts.requestId, 6, 64) ? { request_id: opts.requestId } : {}),
      ...(inRange(opts.userIdHash, 6, 128) ? { user_id: opts.userIdHash } : {}),
    };
  }
}

const inRange = (value: string | undefined, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;

/** Detects the image MIME from magic bytes so the data URI advertises the right type. */
const imageMime = (buffer: Buffer): string => {
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
    if (buffer[0] === 0x49 && buffer[1] === 0x49) return "image/tiff";
    if (buffer[0] === 0x4d && buffer[1] === 0x4d) return "image/tiff";
    if (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }
  }
  return "image/png";
};

export { GlmClient } from "./client";
export type { LayoutParsingRequest, LayoutParsingResponse, LayoutDetail } from "./client";
