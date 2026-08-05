import { defineOcrFunction, OcrFunction } from "../define";
import { formDataExtractionArgsSchema } from "./args";
import { buildFormResultSchema } from "./result";
import { executeFormDataExtraction } from "./execute";

export const formDataExtraction = defineOcrFunction({
  key: OcrFunction.FORM_DATA_EXTRACTION,
  description: "Extract caller-defined fields (FieldSpec[] or JSON Schema) from a form document.",
  accepts: ["pdf", "image", "docx"],
  requires: ["text"],
  sensitivity: "standard",
  maxPages: 20,
  argsSchema: formDataExtractionArgsSchema,
  // Dynamic: the result shape depends on the caller's field spec.
  resultSchema: buildFormResultSchema,
  execute: executeFormDataExtraction,
});

export * from "./args";
export * from "./result";
