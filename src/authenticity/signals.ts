import type { TamperSeverity, TamperSignal, TamperSignals, TamperVerdict } from "./types";

/** Per-severity suspicion weight. Tune against a labelled corpus. */
const WEIGHT: Record<TamperSeverity, number> = {
  info: 0,
  low: 0.15,
  medium: 0.4,
  high: 0.8,
};

/**
 * Combines signals into a 0–1 score via noisy-OR (independent-evidence
 * combination): `1 - Π(1 - weight)`. Two mediums corroborate into more suspicion
 * than one, without any single non-`high` signal dominating.
 */
export const scoreSignals = (signals: TamperSignal[]): number => {
  const clean = signals.reduce((acc, s) => acc * (1 - WEIGHT[s.severity]), 1);
  return Number((1 - clean).toFixed(3));
};

/**
 * Maps signals to a verdict. Absence of signals is `clean` — but the caller must
 * still surface `assuranceLevel: "heuristic-only"`; `clean` never means "authentic".
 */
export const verdictFor = (signals: TamperSignal[], score: number): TamperVerdict => {
  if (signals.some((s) => s.severity === "high")) return "likely-doctored";
  if (signals.some((s) => s.severity === "medium") || score >= 0.35) return "suspicious";
  return "clean";
};

/** Assembles the final {@link TamperSignals} from raw signals. */
export const aggregate = (
  analyzer: TamperSignals["analyzer"],
  signals: TamperSignal[],
  notes?: string[],
): TamperSignals => {
  const score = scoreSignals(signals);
  return {
    verdict: analyzer === "unsupported" ? "inconclusive" : verdictFor(signals, score),
    score,
    signals,
    assuranceLevel: "heuristic-only",
    analyzer,
    notes,
  };
};
