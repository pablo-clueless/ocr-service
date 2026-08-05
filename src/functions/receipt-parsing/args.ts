import { z } from "zod";

export const receiptParsingArgsSchema = z.object({
  /** ISO 4217 code. NGN default for the Nigerian market. */
  currency: z.string().length(3).default("NGN"),
  /** Expected VAT rate for the deterministic post-validation. Nigeria: 7.5%. */
  expectedTaxRate: z.number().min(0).max(1).default(0.075),
});

export type ReceiptParsingArgs = z.infer<typeof receiptParsingArgsSchema>;
