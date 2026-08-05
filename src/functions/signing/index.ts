import { defineOcrFunction, OcrFunction } from "../define";
import { signingArgsSchema } from "./args";
import { signingResultSchema } from "./result";
import { executeSigning } from "./execute";

export const signing = defineOcrFunction({
  key: OcrFunction.SIGNING,
  description: "Detect signatures and seals in an executed document and report execution status.",
  accepts: ["pdf", "image"],
  requires: ["layout", "seals"],
  sensitivity: "standard",
  maxPages: 30,
  argsSchema: signingArgsSchema,
  resultSchema: signingResultSchema,
  execute: executeSigning,
});

export * from "./args";
export * from "./result";
