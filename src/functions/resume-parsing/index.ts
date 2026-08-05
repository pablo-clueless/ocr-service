import { defineOcrFunction, OcrFunction } from "../define";
import { resumeParsingArgsSchema } from "./args";
import { resumeParsingResultSchema } from "./result";
import { executeResumeParsing } from "./execute";

export const resumeParsing = defineOcrFunction({
  key: OcrFunction.RESUME_PARSING,
  description: "Parse a resume into structured contact, experience, education, skills, and languages.",
  accepts: ["pdf", "image", "docx"],
  // layout so two-column PDFs can be reordered by bbox before interpretation.
  requires: ["text", "layout"],
  sensitivity: "pii",
  maxPages: 10,
  argsSchema: resumeParsingArgsSchema,
  resultSchema: resumeParsingResultSchema,
  execute: executeResumeParsing,
});

export * from "./args";
export * from "./result";
