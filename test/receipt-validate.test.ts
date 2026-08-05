import { describe, expect, it } from "vitest";

import { EPSILON, reconcileTotals } from "../src/functions/receipt-parsing/validate";
import type { ReceiptParsingResult } from "../src/functions/receipt-parsing/result";

const baseReceipt = (overrides: Partial<ReceiptParsingResult> = {}): ReceiptParsingResult => ({
  merchant: { name: "Corner Shop", address: null, tin: null },
  dateTime: null,
  currency: "NGN",
  lineItems: [
    { description: "Rice", qty: 1, unitPrice: 200, total: 200 },
    { description: "Beans", qty: 1, unitPrice: 100, total: 100 },
  ],
  subtotal: 300,
  tax: 0,
  tip: 0,
  total: 300,
  paymentMethod: null,
  confidence: "high",
  warnings: [],
  ...overrides,
});

describe("reconcileTotals", () => {
  it("keeps confidence high when line items and totals reconcile", () => {
    const result = reconcileTotals(baseReceipt());
    expect(result.confidence).toBe("high");
    expect(result.warnings).toHaveLength(0);
  });

  it("downgrades to low and warns when line items don't sum to subtotal", () => {
    const result = reconcileTotals(baseReceipt({ subtotal: 500 }));
    expect(result.confidence).toBe("low");
    expect(result.warnings.some((w) => /Line items sum/.test(w))).toBe(true);
  });

  it("downgrades to low when subtotal + tax + tip != total", () => {
    const result = reconcileTotals(baseReceipt({ tax: 50 })); // total still 300
    expect(result.confidence).toBe("low");
    expect(result.warnings.some((w) => /but total is/.test(w))).toBe(true);
  });

  it("does not fail — it degrades (returns a result, never throws)", () => {
    const result = reconcileTotals(baseReceipt({ subtotal: 999, total: 999 }));
    expect(result).toMatchObject({ confidence: "low" });
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("tolerates rounding within the relative epsilon", () => {
    // 0.5% drift on a large invoice stays within EPSILON (2%).
    const drift = 3_000_000 * 0.005;
    const result = reconcileTotals(
      baseReceipt({
        lineItems: [{ description: "Services", qty: 1, unitPrice: 3_000_000, total: 3_000_000 + drift }],
        subtotal: 3_000_000,
        total: 3_000_000,
      }),
    );
    expect(result.confidence).toBe("high");
  });

  it("preserves pre-existing warnings", () => {
    const result = reconcileTotals(baseReceipt({ warnings: ["ocr blur"] }));
    expect(result.warnings).toContain("ocr blur");
  });

  it("exposes a sane default epsilon", () => {
    expect(EPSILON).toBeGreaterThan(0);
    expect(EPSILON).toBeLessThan(1);
  });
});
