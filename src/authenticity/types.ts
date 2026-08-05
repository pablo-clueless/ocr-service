/**
 * Tamper-detection signals (docs/tamper-detection.md). This is **heuristic
 * authenticity signalling, not forensic proof** — it raises well-founded
 * suspicion and catches lazy edits, but a competent forger who rebuilds and
 * re-flattens a file defeats every signal here. Always report `assuranceLevel`,
 * never a naked "authentic: true".
 *
 * The goal is not "was it modified" (almost every real PDF was) but "were the
 * modifications confined to the intended editing surface" — a legitimately
 * *filled* form vs. a *doctored* document.
 */
export type TamperVerdict = "clean" | "suspicious" | "likely-doctored" | "inconclusive";

export type TamperSeverity = "info" | "low" | "medium" | "high";

export type TamperSignal = {
  /** Stable machine code, e.g. "PDF_POST_SIGNATURE_EDIT". */
  code: string;
  severity: TamperSeverity;
  /** Human-readable explanation. */
  detail: string;
};

export type TamperSignals = {
  verdict: TamperVerdict;
  /** Aggregated 0–1 suspicion score. Calibrate thresholds on a golden corpus. */
  score: number;
  signals: TamperSignal[];
  /** Always heuristic — see the module doc. */
  assuranceLevel: "heuristic-only";
  /** Which analyzer ran, for transparency. */
  analyzer: "pdf" | "image" | "unsupported";
  /** Notes on what was *not* checked (e.g. deep image forensics not enabled). */
  notes?: string[];
};
