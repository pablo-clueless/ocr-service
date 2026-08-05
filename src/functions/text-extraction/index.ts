import { defineOcrFunction, OcrFunction } from "../define";
import { textExtractionArgsSchema } from "./args";
import { textExtractionResultSchema } from "./result";
import { executeTextExtraction } from "./execute";

export const textExtraction = defineOcrFunction({
  key: OcrFunction.TEXT_EXTRACTION,
  description: "Extract the document's text as markdown or plain text, optionally with layout blocks.",
  accepts: ["pdf", "image", "docx", "text"],
  requires: ["text"],
  sensitivity: "standard",
  maxPages: 100,
  argsSchema: textExtractionArgsSchema,
  resultSchema: textExtractionResultSchema,
  execute: executeTextExtraction,
});

export * from "./args";
export * from "./result";
