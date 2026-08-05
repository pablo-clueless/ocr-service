import pLimit from "p-limit";

/**
 * Splits multi-page PDFs into page-level image calls run with bounded
 * concurrency. GLM's throughput profile rewards page-parallel
 * base64 image calls over serial file upload, and this also sidesteps the PDF
 * page cap.
 */
export type PageChunk = {
  /** 1-based page number this chunk covers. */
  page: number;
  /** base64 data URI of the rasterized page (`data:image/png;base64,...`). */
  dataUri: string;
};

/**
 * Rasterizes each PDF page to a PNG data URI via pdf-to-img (ESM-only → dynamic
 * import). `pageRange` is a 1-based inclusive filter; omitted means every page.
 */
export const splitPdfToPageImages = async (buffer: Buffer, pageRange?: [number, number]): Promise<PageChunk[]> => {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(buffer, { scale: 2 });
  const [from, to] = pageRange ?? [1, doc.length];

  const chunks: PageChunk[] = [];
  let page = 0;
  for await (const image of doc) {
    page++;
    if (page < from) continue;
    if (page > to) break;
    chunks.push({ page, dataUri: `data:image/png;base64,${image.toString("base64")}` });
  }
  return chunks;
};

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving order.
 * Backed by `p-limit`.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const run = pLimit(Math.max(1, limit));
  return Promise.all(items.map((item, index) => run(() => task(item, index))));
};
