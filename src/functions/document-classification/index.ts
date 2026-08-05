import { defineOcrFunction, OcrFunction } from "../define";
import { documentClassificationArgsSchema } from "./args";
import { documentClassificationResultSchema } from "./result";
import { executeDocumentClassification } from "./execute";

export const documentClassification = defineOcrFunction({
  key: OcrFunction.DOCUMENT_CLASSIFICATION,
  description: "Detect a document's type/label with confidence, alternatives, and a rationale.",
  accepts: ["pdf", "image", "docx"],
  requires: ["text"],
  sensitivity: "standard",
  maxPages: 100,
  argsSchema: documentClassificationArgsSchema,
  resultSchema: documentClassificationResultSchema,
  execute: executeDocumentClassification,
});

export * from "./args";
export * from "./result";
