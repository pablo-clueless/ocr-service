import { defineOcrFunction, OcrFunction } from "../define";
import { receiptParsingArgsSchema } from "./args";
import { receiptParsingResultSchema } from "./result";
import { executeReceiptParsing } from "./execute";

export const receiptParsing = defineOcrFunction({
  key: OcrFunction.RECEIPT_PARSING,
  description: "Parse a receipt into merchant, line items, totals, and payment method with totals reconciliation.",
  accepts: ["pdf", "image"],
  requires: ["text", "tables"],
  sensitivity: "standard",
  maxPages: 5,
  argsSchema: receiptParsingArgsSchema,
  resultSchema: receiptParsingResultSchema,
  execute: executeReceiptParsing,
});

export * from "./args";
export * from "./result";
