import { createWorker, type Word } from "tesseract.js";

import type {
  Capability,
  DocumentInput,
  LayoutBlock,
  MimeGroup,
  OcrProvider,
  PageResult,
  RecognizedDocument,
  RecognizeOptions,
} from "./types";

/**
 * Tesseract OCR. Accepts images and rasterized PDFs. Synthesizes `blocks` from
 * word boxes normalized to 0–1 so bbox consumers don't care which provider ran.
 * Serves as the image / scanned-PDF fallback behind GLM-OCR.
 */
export class TesseractProvider implements OcrProvider {
  readonly name = "tesseract";
  readonly accepts: readonly MimeGroup[] = ["image", "pdf"];
  readonly capabilities: readonly Capability[] = ["text", "layout"];

  async recognize(input: DocumentInput, opts: RecognizeOptions): Promise<RecognizedDocument> {
    const start = Date.now();
    const lang = opts.language ?? "eng";
    const images = input.mimeGroup === "pdf" ? await rasterizePdf(input.buffer, opts.pageRange) : [input.buffer];

    const worker = await createWorker(lang);
    try {
      const pages: PageResult[] = [];
      const blocks: LayoutBlock[] = [];
      let blockIndex = 0;

      for (let i = 0; i < images.length; i++) {
        const image = images[i]!;
        const page = i + 1;
        const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
        pages.push({ page, markdown: data.text.trim() });

        const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
        const dims = pageDimensions(words);
        for (const word of words) {
          blocks.push({
            index: blockIndex++,
            page,
            label: "text",
            bbox: normalizeBbox(word, dims),
            content: word.text,
          });
        }
      }

      const markdown = pages
        .map((p) => p.markdown)
        .join("\n\n")
        .trim();
      return {
        markdown,
        plainText: markdown,
        pages,
        blocks,
        pageCount: pages.length,
        provider: this.name,
        durationMs: Date.now() - start,
      };
    } finally {
      await worker.terminate();
    }
  }
}

/** Tesseract emits pixel coords; page size is inferred from the union of word boxes. */
type Dimensions = { width: number; height: number };

const pageDimensions = (words: Word[]): Dimensions => {
  let width = 1;
  let height = 1;
  for (const w of words) {
    if (w.bbox.x1 > width) width = w.bbox.x1;
    if (w.bbox.y1 > height) height = w.bbox.y1;
  }
  return { width, height };
};

const normalizeBbox = (word: Word, dims: Dimensions): [number, number, number, number] => [
  word.bbox.x0 / dims.width,
  word.bbox.y0 / dims.height,
  word.bbox.x1 / dims.width,
  word.bbox.y1 / dims.height,
];

/** Renders PDF pages to PNG buffers via pdf-to-img (ESM-only → dynamic import). */
const rasterizePdf = async (buffer: Buffer, pageRange?: [number, number]): Promise<Buffer[]> => {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(buffer, { scale: 2 });
  const [from, to] = pageRange ?? [1, doc.length];
  const images: Buffer[] = [];
  let page = 0;
  for await (const image of doc) {
    page++;
    if (page < from) continue;
    if (page > to) break;
    images.push(image);
  }
  return images;
};
