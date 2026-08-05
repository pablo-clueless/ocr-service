import { z } from "zod";

const lineItemSchema = z.object({
  description: z.string(),
  qty: z.number().nullable(),
  unitPrice: z.number().nullable(),
  total: z.number().nullable(),
});

export const receiptParsingResultSchema = z.object({
  merchant: z.object({
    name: z.string().nullable(),
    address: z.string().nullable(),
    tin: z.string().nullable(),
  }),
  dateTime: z.string().nullable(),
  currency: z.string().nullable(),
  lineItems: z.array(lineItemSchema),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  tip: z.number().nullable(),
  total: z.number().nullable(),
  paymentMethod: z.string().nullable(),
  /** Deterministic post-validation verdict: totals reconciliation. */
  confidence: z.enum(["high", "low"]),
  warnings: z.array(z.string()),
});

export type ReceiptParsingResult = z.infer<typeof receiptParsingResultSchema>;
