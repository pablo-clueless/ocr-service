import { buildResumeParsingPrompt } from "./prompt";
import { resumeParsingResultSchema } from "./result";
import type { LayoutBlock } from "../../providers/types";
import type { ResumeParsingArgs } from "./args";
import type { ResumeParsingResult } from "./result";
import type { OcrContext } from "../define";

/**
 * Parses a resume. The gotcha is reading order: two-column layouts
 * make pdf-parse interleave columns into garbage, so PDF resumes route through
 * GLM-OCR and this step reconstructs column order from `doc.blocks` bboxes
 * before building the LLM input. DOCX resumes come through mammoth cleanly and
 * fall back to the provider's markdown.
 */
export const executeResumeParsing = async (ctx: OcrContext, args: ResumeParsingArgs): Promise<ResumeParsingResult> => {
  const markdown = reconstructReadingOrder(ctx.doc.blocks) || ctx.doc.markdown;
  const { system, user } = buildResumeParsingPrompt(markdown, args);

  const { data } = await ctx.llm.complete({
    system,
    user,
    schema: resumeParsingResultSchema,
    schemaName: "RESUME_PARSING_result",
  });

  return data;
};

/**
 * Rebuilds reading order from layout blocks. Detects a two-column gutter per
 * page and emits the left column top-to-bottom, then the right — the fix for
 * interleaved-column resumes. Returns "" when there's no usable geometry so the
 * caller falls back to the provider's markdown (single-column / text sources).
 */
const reconstructReadingOrder = (blocks: readonly LayoutBlock[]): string => {
  const usable = blocks.filter((b) => b.bbox && b.content.trim());
  if (usable.length === 0) return "";

  const pages = [...new Set(usable.map((b) => b.page))].sort((a, b) => a - b);
  return pages
    .map((page) => orderPage(usable.filter((b) => b.page === page)))
    .join("\n\n")
    .trim();
};

/** Column-major (gutter-split) then top-to-bottom ordering of one page's blocks. */
const orderPage = (blocks: LayoutBlock[]): string => {
  const gutter = detectGutter(blocks);
  const rank = (b: LayoutBlock): number => {
    const [x0, y0] = b.bbox!;
    const column = gutter !== null && x0 >= gutter ? 1 : 0;
    return column + y0; // column dominates (y0 ∈ [0,1)); ties break top-to-bottom
  };
  return [...blocks]
    .sort((a, b) => rank(a) - rank(b))
    .map((b) => b.content.trim())
    .join("\n");
};

/** X-center gutter threshold: a ≥0.15-wide gap in the page's middle band signals two columns. */
const MIN_GUTTER_WIDTH = 0.15;

/** Finds the x-coordinate of a two-column gutter, or null if the page is single-column. */
const detectGutter = (blocks: LayoutBlock[]): number | null => {
  const centers = blocks.map((b) => (b.bbox![0] + b.bbox![2]) / 2).sort((a, b) => a - b);
  let widest = 0;
  let gutter: number | null = null;
  for (let i = 1; i < centers.length; i++) {
    const gap = centers[i]! - centers[i - 1]!;
    const mid = (centers[i]! + centers[i - 1]!) / 2;
    if (gap > widest && mid > 0.3 && mid < 0.7) {
      widest = gap;
      gutter = mid;
    }
  }
  return widest >= MIN_GUTTER_WIDTH ? gutter : null;
};
