import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import type { OcrFunctionKey } from "../functions/define";

/**
 * Per-request metrics envelope. Emitted once per completed request.
 * Two series drive alerts: `providerFallback` (silent upstream degradation) and
 * `lowConfidence` (quality regression after a prompt/model change).
 */
export type RequestMetrics = {
  function: OcrFunctionKey;
  mimeGroup: string;
  pageCount: number;
  provider: string;
  fellBackFrom?: string;
  cached: boolean;
  ingestMs: number;
  extractMs: number;
  interpretMs: number;
  tokensUsed?: number;
  estimatedCostNgn?: number;
  outcome: "success" | "error";
};

export interface Metrics {
  recordRequest(m: RequestMetrics): void;
  /** ocr_provider_fallback_total{from,to} */
  incrementFallback(from: string, to: string): void;
  /** ocr_low_confidence_ratio{function} */
  recordConfidence(fn: OcrFunctionKey, low: boolean): void;
}

/** Dedicated registry so `/metrics` renders exactly this service's series + Node defaults. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const DURATION_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000];
const PAGE_BUCKETS = [1, 2, 5, 10, 20, 30, 50, 100];

const requestsTotal = new Counter({
  name: "ocr_requests_total",
  help: "OCR requests processed, by function/provider/outcome.",
  labelNames: ["function", "provider", "mime_group", "cached", "outcome"] as const,
  registers: [registry],
});

const extractDurationMs = new Histogram({
  name: "ocr_extract_duration_ms",
  help: "Extraction stage duration in milliseconds.",
  labelNames: ["function", "provider"] as const,
  buckets: DURATION_BUCKETS_MS,
  registers: [registry],
});

const interpretDurationMs = new Histogram({
  name: "ocr_interpret_duration_ms",
  help: "Interpretation stage duration in milliseconds.",
  labelNames: ["function"] as const,
  buckets: DURATION_BUCKETS_MS,
  registers: [registry],
});

const pageCount = new Histogram({
  name: "ocr_page_count",
  help: "Pages per processed document.",
  labelNames: ["function"] as const,
  buckets: PAGE_BUCKETS,
  registers: [registry],
});

const tokensUsedTotal = new Counter({
  name: "ocr_tokens_used_total",
  help: "LLM tokens consumed, by function/provider.",
  labelNames: ["function", "provider"] as const,
  registers: [registry],
});

const estimatedCostNgnTotal = new Counter({
  name: "ocr_estimated_cost_ngn_total",
  help: "Estimated cost in NGN, by function.",
  labelNames: ["function"] as const,
  registers: [registry],
});

const providerFallbackTotal = new Counter({
  name: "ocr_provider_fallback_total",
  help: "Provider fallbacks — a rising rate signals silent upstream degradation.",
  labelNames: ["from", "to"] as const,
  registers: [registry],
});

// A ratio is a derived query; the SLI is exposed as its two component counters.
const confidenceObservationsTotal = new Counter({
  name: "ocr_confidence_observations_total",
  help: "Confidence observations recorded, by function (denominator of the low-confidence ratio).",
  labelNames: ["function"] as const,
  registers: [registry],
});

const lowConfidenceTotal = new Counter({
  name: "ocr_low_confidence_total",
  help: "Low-confidence observations, by function (numerator of the low-confidence ratio).",
  labelNames: ["function"] as const,
  registers: [registry],
});

export const metrics: Metrics = {
  recordRequest(m) {
    requestsTotal.inc({
      function: m.function,
      provider: m.provider,
      mime_group: m.mimeGroup,
      cached: String(m.cached),
      outcome: m.outcome,
    });
    // Latency/page distributions describe *processed* documents; a failed request
    // has partial or zero timings, so observing it would understate the histograms.
    // The failure is still counted above via `outcome="error"`.
    if (m.outcome === "success") {
      extractDurationMs.observe({ function: m.function, provider: m.provider }, m.extractMs);
      interpretDurationMs.observe({ function: m.function }, m.interpretMs);
      pageCount.observe({ function: m.function }, m.pageCount);
    }
    if (m.tokensUsed) tokensUsedTotal.inc({ function: m.function, provider: m.provider }, m.tokensUsed);
    if (m.estimatedCostNgn) estimatedCostNgnTotal.inc({ function: m.function }, m.estimatedCostNgn);
  },

  incrementFallback(from, to) {
    providerFallbackTotal.inc({ from, to });
  },

  recordConfidence(fn, low) {
    confidenceObservationsTotal.inc({ function: fn });
    if (low) lowConfidenceTotal.inc({ function: fn });
  },
};

/** Prometheus exposition-format content type, for the `/metrics` response header. */
export const metricsContentType = registry.contentType;

/** Renders the current registry in Prometheus text format. */
export const renderMetrics = (): Promise<string> => registry.metrics();

/** A friendly, already-aggregated view of the registry for the admin console. */
export type MetricsSummary = {
  totalRequests: number;
  errorRequests: number;
  /** errors / total, 0 when there is no traffic yet. */
  errorRate: number;
  totalTokens: number;
  providerFallbacks: number;
  /** Per-function request/error/token rollup, plus the low-confidence ratio. */
  byFunction: Array<{
    function: string;
    requests: number;
    errors: number;
    tokens: number;
    lowConfidenceRatio: number;
  }>;
};

type JsonMetric = { name: string; values: Array<{ value: number; labels: Record<string, string> }> };

/** Sums a counter's samples, optionally filtered by a label predicate. */
const sumValues = (metrics: JsonMetric[], name: string, pred?: (labels: Record<string, string>) => boolean): number => {
  const m = metrics.find((x) => x.name === name);
  if (!m) return 0;
  return m.values.reduce((acc, s) => (pred && !pred(s.labels) ? acc : acc + s.value), 0);
};

/**
 * Aggregates the raw prom-client registry into {@link MetricsSummary}. Reads the
 * structured JSON (`getMetricsAsJSON`) rather than parsing the text exposition, so
 * it stays in step with the series defined above without brittle string parsing.
 */
export const getMetricsSummary = async (): Promise<MetricsSummary> => {
  const raw = (await registry.getMetricsAsJSON()) as unknown as JsonMetric[];

  const totalRequests = sumValues(raw, "ocr_requests_total");
  const errorRequests = sumValues(raw, "ocr_requests_total", (l) => l.outcome === "error");

  const functions = new Set<string>();
  for (const name of ["ocr_requests_total", "ocr_tokens_used_total", "ocr_confidence_observations_total"]) {
    for (const s of raw.find((x) => x.name === name)?.values ?? []) {
      if (s.labels.function) functions.add(s.labels.function);
    }
  }

  const byFunction = [...functions]
    .map((fn) => {
      const requests = sumValues(raw, "ocr_requests_total", (l) => l.function === fn);
      const errors = sumValues(raw, "ocr_requests_total", (l) => l.function === fn && l.outcome === "error");
      const tokens = sumValues(raw, "ocr_tokens_used_total", (l) => l.function === fn);
      const obs = sumValues(raw, "ocr_confidence_observations_total", (l) => l.function === fn);
      const low = sumValues(raw, "ocr_low_confidence_total", (l) => l.function === fn);
      return { function: fn, requests, errors, tokens, lowConfidenceRatio: obs ? low / obs : 0 };
    })
    .sort((a, b) => b.requests - a.requests);

  return {
    totalRequests,
    errorRequests,
    errorRate: totalRequests ? errorRequests / totalRequests : 0,
    totalTokens: sumValues(raw, "ocr_tokens_used_total"),
    providerFallbacks: sumValues(raw, "ocr_provider_fallback_total"),
    byFunction,
  };
};
