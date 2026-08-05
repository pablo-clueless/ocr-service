import { buildReceiptParsingPrompt } from "./prompt";
import { receiptParsingResultSchema } from "./result";
import { reconcileTotals } from "./validate";
import type { ReceiptParsingArgs } from "./args";
import type { ReceiptParsingResult } from "./result";
import type { OcrContext } from "../define";

/**
 * Parses a receipt, then runs deterministic totals reconciliation
 * (see `validate.ts`). Handwritten and thermal-printed receipts are exactly
 * where GLM-OCR beats Tesseract hardest.
 *
 * The model reports only what the receipt shows (told not to compute totals);
 * `reconcileTotals` then recomputes the `confidence` verdict and warnings
 * deterministically, never trusting the model's own arithmetic.
 */
export const executeReceiptParsing = async (
  ctx: OcrContext,
  args: ReceiptParsingArgs,
): Promise<ReceiptParsingResult> => {
  const { system, user } = buildReceiptParsingPrompt(ctx.doc.markdown, args);

  const { data } = await ctx.llm.complete({
    system,
    user,
    schema: receiptParsingResultSchema,
    schemaName: "RECEIPT_PARSING_result",
  });

  return reconcileTotals(data);
};
