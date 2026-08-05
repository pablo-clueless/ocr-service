import { analyzeTamper } from "../../authenticity";
import type { OcrContext } from "../define";
import type { DocumentAuthenticityArgs } from "./args";
import type { DocumentAuthenticityResult } from "./result";

/**
 * Runs the deterministic tamper-detection tier over the raw uploaded bytes
 * (docs/tamper-detection.md). No LLM, no external services — `skipExtraction` on
 * the definition means no OCR pass runs either.
 */
export const executeDocumentAuthenticity = async (
  ctx: OcrContext,
  _args: DocumentAuthenticityArgs,
): Promise<DocumentAuthenticityResult> => {
  return analyzeTamper(ctx.file.buffer, ctx.file.mimeGroup);
};
