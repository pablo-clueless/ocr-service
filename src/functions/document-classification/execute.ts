import { buildDocumentClassificationPrompt } from "./prompt";
import { documentClassificationResultSchema } from "./result";
import type { DocumentClassificationArgs } from "./args";
import type { DocumentClassificationResult } from "./result";
import type { OcrContext } from "../define";

/**
 * Classifies the document. Built to be internally reusable: the
 * auto-routing feature ("figure out what this is, then parse it") composes on
 * top of this, so keep it callable outside the HTTP path.
 *
 * Cost control: classifies from page-1 markdown unless `args.fullDocument`.
 */
export const executeDocumentClassification = async (
  ctx: OcrContext,
  args: DocumentClassificationArgs,
): Promise<DocumentClassificationResult> => {
  const markdown = args.fullDocument ? ctx.doc.markdown : firstPageMarkdown(ctx.doc);
  const { system, user } = buildDocumentClassificationPrompt(markdown, args);

  const { data } = await ctx.llm.complete({
    system,
    user,
    schema: documentClassificationResultSchema,
    schemaName: "DOCUMENT_CLASSIFICATION_result",
  });

  // Honor `minConfidence` / `allowUnknown`: a low-confidence label collapses to
  // "unknown" when the caller permits it, so downstream routing can trust the label.
  if (data.confidence < args.minConfidence && args.allowUnknown && data.label !== "unknown") {
    return { ...data, label: "unknown" };
  }
  return data;
};

/** Page-1 markdown, falling back to whole-document markdown for single-page/text sources. */
const firstPageMarkdown = (doc: OcrContext["doc"]): string => {
  const page1 = doc.pages.find((p) => p.page === 1) ?? doc.pages[0];
  return page1?.markdown?.trim() || doc.markdown;
};
