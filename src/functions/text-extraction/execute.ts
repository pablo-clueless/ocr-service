import type { OcrContext } from "../define";
import type { TextExtractionArgs } from "./args";
import type { TextExtractionResult } from "./result";

/**
 * No LLM step. Returns the canonical document more or less
 * directly — honoring `format`, optional `pageRange`, and `includeBlocks`.
 * The cheapest path and the smoke test.
 */
export const executeTextExtraction = async (
  ctx: OcrContext,
  args: TextExtractionArgs,
): Promise<TextExtractionResult> => {
  const { doc } = ctx;
  const pages = args.pageRange
    ? doc.pages.filter((p) => p.page >= args.pageRange![0] && p.page <= args.pageRange![1])
    : doc.pages;

  const text =
    args.format === "plain"
      ? pagesToPlain(pages, doc.plainText, !!args.pageRange)
      : pages
          .map((p) => p.markdown)
          .join("\n\n")
          .trim() || doc.markdown;

  const result: TextExtractionResult = {
    text,
    format: args.format,
    pageCount: doc.pageCount,
  };

  if (args.includeBlocks) {
    const inRange = args.pageRange
      ? doc.blocks.filter((b) => b.page >= args.pageRange![0] && b.page <= args.pageRange![1])
      : doc.blocks;
    result.blocks = inRange.map((b) => ({
      index: b.index,
      page: b.page,
      label: b.label,
      bbox: b.bbox,
      content: b.content,
    }));
  }

  return result;
};

/** Plain-text join. Providers without per-page markdown fall back to the whole-doc plainText. */
const pagesToPlain = (pages: { markdown: string }[], whole: string, ranged: boolean): string => {
  if (!ranged && pages.length <= 1) return whole.trim();
  return pages
    .map((p) => stripMarkdown(p.markdown))
    .join("\n\n")
    .trim();
};

/** Coarse markdown → plain text for the `plain` format when only markdown is available. */
const stripMarkdown = (md: string): string =>
  md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
