import type { ReceiptParsingArgs } from "./args";
import { buildSystem, wrapUntrusted } from "../../llm/prompt";

export type Prompt = { system: string; user: string };

export const buildReceiptParsingPrompt = (markdown: string, args: ReceiptParsingArgs): Prompt => {
  const system = buildSystem([
    "You are a receipt parsing assistant.",
    `Extract merchant details (name, address, TIN), date/time, currency, line items`,
    "(description, qty, unit price, total), subtotal, tax, tip, total, and payment method.",
    `Default currency is ${args.currency}; VAT is typically ${(args.expectedTaxRate * 100).toFixed(1)}%.`,
    "Use null for any field not present. Do not compute totals — report only what the receipt shows.",
  ]);

  const user = `Parse this receipt:\n\n${wrapUntrusted("RECEIPT", markdown)}`;
  return { system, user };
};
