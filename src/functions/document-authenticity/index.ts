import { defineOcrFunction, OcrFunction } from "../define";
import { documentAuthenticityArgsSchema } from "./args";
import { documentAuthenticityResultSchema } from "./result";
import { executeDocumentAuthenticity } from "./execute";

export const documentAuthenticity = defineOcrFunction({
  key: OcrFunction.DOCUMENT_AUTHENTICITY,
  description:
    "Heuristically assess whether a PDF or image was doctored vs. legitimately filled. Deterministic (no OCR/LLM); heuristic-only assurance.",
  accepts: ["pdf", "image"],
  requires: [],
  sensitivity: "standard",
  maxPages: 1000,
  // Works on the raw container bytes; no OCR text is needed.
  skipExtraction: true,
  argsSchema: documentAuthenticityArgsSchema,
  resultSchema: documentAuthenticityResultSchema,
  execute: executeDocumentAuthenticity,
});

export * from "./args";
export * from "./result";
