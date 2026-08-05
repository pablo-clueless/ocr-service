import type { ReceiptParsingResult } from "./result";

/**
 * Deterministic post-validation, not LLM trust: line items sum ≈
 * subtotal, and subtotal + tax + tip ≈ total, within a small epsilon. On
 * mismatch don't fail — downgrade `confidence` to "low" and append warnings so
 * callers can route to human review.
 *
 * `EPSILON` is a relative tolerance (with a tiny absolute floor) so it holds for
 * both a ₦300 corner-shop receipt and a ₦3,000,000 invoice.
 */
export const EPSILON = 0.02;

const approxEqual = (a: number, b: number, epsilon: number): boolean =>
  Math.abs(a - b) <= Math.max(epsilon, epsilon * Math.abs(b));

export const reconcileTotals = (result: ReceiptParsingResult, epsilon = EPSILON): ReceiptParsingResult => {
  const warnings = [...result.warnings];
  let confidence: ReceiptParsingResult["confidence"] = "high";

  const itemsWithTotal = result.lineItems.filter((li) => li.total != null);
  if (itemsWithTotal.length > 0 && result.subtotal != null) {
    const lineSum = itemsWithTotal.reduce((acc, li) => acc + (li.total ?? 0), 0);
    if (!approxEqual(lineSum, result.subtotal, epsilon)) {
      confidence = "low";
      warnings.push(`Line items sum to ${lineSum.toFixed(2)} but subtotal is ${result.subtotal.toFixed(2)}.`);
    }
  }

  const hasComponents = result.subtotal != null || result.tax != null || result.tip != null;
  if (hasComponents && result.total != null) {
    const composed = (result.subtotal ?? 0) + (result.tax ?? 0) + (result.tip ?? 0);
    if (!approxEqual(composed, result.total, epsilon)) {
      confidence = "low";
      warnings.push(`Subtotal + tax + tip = ${composed.toFixed(2)} but total is ${result.total.toFixed(2)}.`);
    }
  }

  return { ...result, confidence, warnings };
};
