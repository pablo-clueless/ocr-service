import type { BlockLabel, LayoutBlock, PageResult, RecognizedDocument } from "../types";
import type { LayoutParsingResponse } from "./client";

const KNOWN_LABELS: readonly BlockLabel[] = ["image", "text", "formula", "table"];

/**
 * Maps an upstream label to our {@link BlockLabel}. Unknown labels degrade to
 * `image` (safe for geometry, keeps `content`) rather than throwing, so an
 * upstream label change degrades instead of 500-ing — see docs/glm-ocr.md.
 */
const toBlockLabel = (label: string): BlockLabel =>
  (KNOWN_LABELS as readonly string[]).includes(label) ? (label as BlockLabel) : "image";

/**
 * Maps one or more {@link LayoutParsingResponse} chunks into the canonical
 * {@link RecognizedDocument}. GLM's `bbox_2d` is already normalized 0–1, so it
 * carries straight into {@link LayoutBlock.bbox}. `label` maps 1:1.
 *
 * @param responses - Per-chunk responses in page order (chunker output).
 * @param meta - Provider name + timing to stamp onto the result.
 */
export const mapLayoutParsing = (
  responses: LayoutParsingResponse[],
  meta: { provider: string; durationMs: number; fellBackFrom?: string },
): RecognizedDocument => {
  const pages: PageResult[] = [];
  const blocks: LayoutBlock[] = [];
  let pageOffset = 0;
  let tokensUsed = 0;

  for (const response of responses) {
    const responsePages = toPages(response, pageOffset);
    blocks.push(...toBlocks(response, pageOffset));
    pages.push(...responsePages);
    pageOffset += responsePages.length;
    tokensUsed += response.usage?.total_tokens ?? 0;
  }

  // Blocks are indexed per-response upstream; re-index globally so the document
  // exposes one monotonic sequence.
  blocks.forEach((block, i) => {
    block.index = i;
  });

  const markdown = pages
    .map((p) => p.markdown)
    .filter((md) => md.length > 0)
    .join("\n\n")
    .trim();

  return {
    markdown,
    plainText: markdown,
    pages,
    blocks,
    pageCount: pages.length,
    provider: meta.provider,
    ...(meta.fellBackFrom ? { fellBackFrom: meta.fellBackFrom } : {}),
    tokensUsed,
    durationMs: meta.durationMs,
  };
};

/** Flattens a single response's per-page details into a page-numbered block list. */
export const toBlocks = (response: LayoutParsingResponse, pageOffset: number): LayoutBlock[] => {
  const blocks: LayoutBlock[] = [];
  let index = 0;
  (response.layout_details ?? []).forEach((pageDetails, pageIndex) => {
    const page = pageOffset + pageIndex + 1;
    for (const detail of pageDetails ?? []) {
      blocks.push({
        index: index++,
        page,
        label: toBlockLabel(detail.label),
        bbox: detail.bbox_2d,
        content: detail.content ?? "",
      });
    }
  });
  return blocks;
};

/**
 * Derives per-page results from a response. Chunking sends one page per call, so
 * `md_results` is that page's markdown; a defensive multi-page response keeps its
 * markdown on the first page rather than duplicating it across pages.
 */
export const toPages = (response: LayoutParsingResponse, pageOffset: number): PageResult[] => {
  const dims = response.data_info?.pages ?? [];
  const pageCount = Math.max(dims.length, response.layout_details?.length ?? 0, 1);
  const markdown = (response.md_results ?? "").trim();

  const pages: PageResult[] = [];
  for (let i = 0; i < pageCount; i++) {
    const dim = dims[i];
    pages.push({
      page: pageOffset + i + 1,
      markdown: i === 0 ? markdown : "",
      ...(dim ? { width: dim.width, height: dim.height } : {}),
    });
  }
  return pages;
};
