/**
 * Typed client for GLM-OCR's `layout_parsing` endpoint. Not
 * multipart — `file` is a URL or base64 data URI. Prefer base64 data URIs and
 * page-splitting (see chunker) to sidestep the 50 MB / page-cap limits and to
 * avoid exposing the blob store.
 */

export type LayoutDetailLabel = "image" | "text" | "formula" | "table";

/** One layout region. `bbox_2d` is normalized 0–1. Table blocks return HTML in `content`. */
export type LayoutDetail = {
  index: number;
  label: LayoutDetailLabel;
  bbox_2d: [number, number, number, number];
  content: string;
  height: number;
  width: number;
};

export type LayoutParsingResponse = {
  id: string;
  created: number;
  model: string;
  md_results: string;
  /** One array per page, each holding that page's blocks. */
  layout_details: LayoutDetail[][];
  layout_visualization?: string[];
  data_info: { num_pages: number; pages: { width: number; height: number }[] };
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  request_id: string;
};

export type LayoutParsingRequest = {
  model: "glm-ocr";
  /** URL or base64 data URI (`data:image/png;base64,...`). */
  file: string;
  return_crop_images?: boolean;
  need_layout_visualization?: boolean;
  /** 1-based inclusive PDF page range — the chunking lever. */
  start_page_id?: number;
  end_page_id?: number;
  /** 6–64 chars, unique. Carries our job id for tracing/idempotency. */
  request_id?: string;
  /** 6–128 chars. Send a hashed tenant id, never a raw one. */
  user_id?: string;
};

export type GlmClientOptions = {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
/** 429 (rate limit) + 5xx (transient upstream) are worth retrying; 4xx are not. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

export class GlmClient {
  constructor(private readonly opts: GlmClientOptions) {}

  /** POST /layout_parsing with bounded retries on 429/5xx. */
  async layoutParsing(req: LayoutParsingRequest, signal?: AbortSignal): Promise<LayoutParsingResponse> {
    const url = `${this.opts.baseUrl}/layout_parsing`;
    const maxRetries = this.opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // A fresh per-attempt timeout, combined with the caller's cancellation signal.
      const timeout = AbortSignal.timeout(timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(req),
          signal: composite,
        });
      } catch (err) {
        // A caller-initiated abort is terminal; network errors and per-attempt
        // timeouts are retried.
        if (signal?.aborted) throw err;
        lastError = err;
        if (attempt >= maxRetries) break;
        await delay(backoffMs(attempt), signal);
        continue;
      }

      if (res.ok) {
        return (await res.json()) as LayoutParsingResponse;
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        lastError = new Error(`GLM layout_parsing ${res.status} ${res.statusText}`);
        await delay(backoffMs(attempt, res.headers.get("retry-after")), signal);
        continue;
      }

      const body = await safeText(res);
      throw new Error(`GLM layout_parsing failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }

    throw lastError instanceof Error ? lastError : new Error(`GLM layout_parsing failed: ${String(lastError)}`);
  }
}

/** Exponential backoff with jitter, honoring an upstream `Retry-After` (seconds) when present. */
const backoffMs = (attempt: number, retryAfter?: string | null): number => {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, BACKOFF_MAX_MS);
  }
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  // Full jitter over the lower half so retries don't synchronize.
  return ceiling / 2 + Math.random() * (ceiling / 2);
};

/** Abortable sleep — a caller abort during backoff rejects promptly rather than waiting it out. */
const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const safeText = async (res: Response): Promise<string> => {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
};
