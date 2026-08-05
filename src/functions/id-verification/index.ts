import { defineOcrFunction, OcrFunction } from "../define";
import { idVerificationArgsSchema } from "./args";
import { idVerificationResultSchema } from "./result";
import { executeIdVerification } from "./execute";

export const idVerification = defineOcrFunction({
  key: OcrFunction.ID_VERIFICATION,
  description: "Extract identity-document fields and verify document-content consistency (not identity assurance).",
  accepts: ["pdf", "image"],
  requires: ["text", "layout"],
  sensitivity: "pii",
  maxPages: 4,
  argsSchema: idVerificationArgsSchema,
  resultSchema: idVerificationResultSchema,
  execute: executeIdVerification,
});

export * from "./args";
export * from "./result";
