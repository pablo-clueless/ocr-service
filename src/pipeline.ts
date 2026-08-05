import type { DocumentInput, OcrProvider, RecognizedDocument, RecognizeOptions } from "./providers/types";
import { resolveResultSchema, type OcrContext, type OcrFunctionDefinition } from "./functions/define";
import { createRedactingLogger, type Logger } from "./observability/logger";
import { extractionCacheKey, type ExtractionCache } from "./cache";
import { recordTenantUsage } from "./observability/usage";
import type { ProviderPolicy } from "./config/providers";
import { withSpan } from "./observability/tracing";
import { routeProvider } from "./providers/router";
import { metrics } from "./observability/metrics";
import { sha256, sniff } from "./ingest/sniff";
import type { LlmClient } from "./llm/azure";
import { OcrError } from "./http/errors";
import { env } from "./config/env";

/**
 * The per-request pipeline:
 *   1. Ingest    multipart → sniff → validate
 *   2. Extract   provider router → RecognizedDocument (cache-backed)
 *   3. Interpret function.execute(ctx, args)
 *   4. Validate  Zod + business rules → result
 *
 * The same code path serves sync and async (the queue worker just calls this
 * off-request), so the orchestration lives in one place.
 */
export type OcrRequest = {
  file: { buffer: Buffer; originalName: string };
  args: unknown;
  requestId: string;
  tenantId: string;
};

export type OcrResponseMeta = {
  provider: string;
  fellBackFrom: string | null;
  pageCount: number;
  cached: boolean;
  confidence?: number;
  durationMs: number;
  tokensUsed?: number;
};

export type OcrOutcome<TResult> = {
  result: TResult;
  meta: OcrResponseMeta;
};

export type PipelineDeps = {
  llm: LlmClient;
  logger: Logger;
  providers: readonly OcrProvider[];
  cache: ExtractionCache;
  policy: ProviderPolicy;
};

type ExtractOutput = { doc: RecognizedDocument; cached: boolean };

/**
 * Runs a request end to end against a resolved function definition.
 *
 * @throws OcrError with a typed {@link import("./http/errors").OcrErrorCode}.
 */
export const runPipeline = async <TArgs, TResult>(
  def: OcrFunctionDefinition<TArgs, TResult>,
  req: OcrRequest,
  deps: PipelineDeps,
): Promise<OcrOutcome<TResult>> => {
  const start = Date.now();
  // Declared outside the try so the error path can label metrics with however far
  // the request got (mime group/provider are unknown if it failed during ingest).
  let input: DocumentInput | undefined;
  let doc: RecognizedDocument | undefined;
  let cached = false;
  let ingestMs = 0;
  let interpretMs = 0;

  try {
    const args = parseArgs(def, req.args);

    const ingestStart = Date.now();
    input = await ingest(req);
    ingestMs = Date.now() - ingestStart;

    if (!def.accepts.includes(input.mimeGroup)) {
      throw new OcrError("UNSUPPORTED_MEDIA_TYPE", `${def.key} does not accept ${input.mimeGroup} files`);
    }

    const opts: RecognizeOptions = { requestId: req.requestId, userIdHash: req.tenantId };
    const extracted = def.skipExtraction
      ? { doc: emptyDocument(), cached: false }
      : await extractDocument(def, input, opts, deps);
    doc = extracted.doc;
    cached = extracted.cached;

    if (doc.pageCount > def.maxPages) {
      throw new OcrError("PAGE_LIMIT_EXCEEDED", `${def.key} allows ${def.maxPages} pages; got ${doc.pageCount}`);
    }

    // `pii`/`restricted` functions get a redacting logger so raw document text and
    // extracted identity fields can never reach the log sink (V2). Enforced here —
    // the single point the context logger is built — so it can't be bypassed.
    const isSensitive = def.sensitivity !== "standard";
    const requestLogger = deps.logger.child({ requestId: req.requestId, function: def.key });

    const ctx: OcrContext = {
      doc,
      file: {
        sha256: input.sha256,
        mimeGroup: input.mimeGroup,
        sizeBytes: input.buffer.length,
        originalName: input.originalName,
        buffer: input.buffer,
      },
      requestId: req.requestId,
      tenantId: req.tenantId,
      llm: deps.llm,
      logger: isSensitive ? createRedactingLogger(requestLogger) : requestLogger,
    };

    // For sensitive functions, disable response-body capture in the trace (V2).
    const interpretStart = Date.now();
    const result = await withSpan(`interpret:${def.key}`, () => interpret(def, ctx, args), {
      captureResult: !isSensitive,
      attributes: { function: def.key, sensitivity: def.sensitivity },
    });
    interpretMs = Date.now() - interpretStart;

    const meta: OcrResponseMeta = {
      provider: doc.provider,
      fellBackFrom: doc.fellBackFrom ?? null,
      pageCount: doc.pageCount,
      cached,
      durationMs: Date.now() - start,
      tokensUsed: doc.tokensUsed,
    };
    metrics.recordRequest({
      function: def.key,
      mimeGroup: input.mimeGroup,
      pageCount: doc.pageCount,
      provider: doc.provider,
      fellBackFrom: doc.fellBackFrom,
      cached,
      ingestMs,
      extractMs: doc.durationMs,
      interpretMs,
      tokensUsed: doc.tokensUsed,
      outcome: "success",
    });
    // Per-tenant counters for the admin console (fire-and-forget; see usage.ts).
    recordTenantUsage(req.tenantId, { outcome: "success", tokensUsed: doc.tokensUsed });

    return { result, meta };
  } catch (err) {
    // Count the failed request so `ocr_requests_total{outcome="error"}` reflects
    // failures too; the histograms are left to successes (see metrics.recordRequest).
    metrics.recordRequest({
      function: def.key,
      mimeGroup: input?.mimeGroup ?? "unknown",
      pageCount: doc?.pageCount ?? 0,
      provider: doc?.provider ?? "none",
      fellBackFrom: doc?.fellBackFrom,
      cached,
      ingestMs,
      extractMs: doc?.durationMs ?? 0,
      interpretMs,
      tokensUsed: doc?.tokensUsed,
      outcome: "error",
    });
    recordTenantUsage(req.tenantId, { outcome: "error", tokensUsed: doc?.tokensUsed });
    throw err;
  }
};

/** Placeholder document for `skipExtraction` functions that work on raw bytes. */
const emptyDocument = (): RecognizedDocument => ({
  markdown: "",
  plainText: "",
  pages: [],
  blocks: [],
  pageCount: 0,
  provider: "none",
  durationMs: 0,
});

/** Stage 1: sniff + hash into a canonical {@link DocumentInput}. */
const ingest = async (req: OcrRequest): Promise<DocumentInput> => {
  const buffer = req.file.buffer;
  const sniffed = await sniff(buffer);
  if (!sniffed) {
    throw new OcrError("UNSUPPORTED_MEDIA_TYPE", "Could not determine a supported file type");
  }
  return { buffer, mimeGroup: sniffed.mimeGroup, sha256: sha256(buffer), originalName: req.file.originalName };
};

/** Stage 2: route → cache lookup → recognize (with fallback) → cache store. */
const extractDocument = async <TArgs, TResult>(
  def: OcrFunctionDefinition<TArgs, TResult>,
  input: DocumentInput,
  opts: RecognizeOptions,
  deps: PipelineDeps,
): Promise<ExtractOutput> => {
  const { provider, fallbacks } = routeProvider(deps.providers, {
    group: input.mimeGroup,
    required: def.requires,
    fn: def.key,
    policy: deps.policy,
  });

  const usesCache = def.sensitivity === "standard";
  const key = extractionCacheKey(input.sha256, provider.name);

  if (usesCache) {
    const hit = await deps.cache.get(key);
    if (hit) return { doc: hit, cached: true };
  }

  const doc = await recognizeWithFallback(provider, fallbacks, input, opts, deps);

  if (usesCache) {
    await deps.cache.set(extractionCacheKey(input.sha256, doc.provider), doc, env.EXTRACTION_CACHE_TTL_SECONDS);
  }
  return { doc, cached: false };
};

/** Tries the primary provider, then each fallback on error, stamping `fellBackFrom`. */
const recognizeWithFallback = async (
  primary: OcrProvider,
  fallbacks: OcrProvider[],
  input: DocumentInput,
  opts: RecognizeOptions,
  deps: PipelineDeps,
): Promise<RecognizedDocument> => {
  const chain = [primary, ...fallbacks];
  let lastError: unknown;

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!;
    try {
      const doc = await provider.recognize(input, opts);
      if (i > 0) {
        doc.fellBackFrom = primary.name;
        metrics.incrementFallback(primary.name, provider.name);
        deps.logger.warn("provider fallback", { from: primary.name, to: provider.name });
      }
      return doc;
    } catch (err) {
      lastError = err;
      deps.logger.error("provider failed", {
        provider: provider.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw new OcrError("EXTRACTION_FAILED", `All providers failed: ${chain.map((p) => p.name).join(", ")}`, {
    retryable: true,
    details: lastError instanceof Error ? lastError.message : String(lastError),
  });
};

/** Stage 3 + 4: run the function, then validate its output against the (possibly dynamic) result schema. */
const interpret = async <TArgs, TResult>(
  def: OcrFunctionDefinition<TArgs, TResult>,
  ctx: OcrContext,
  args: TArgs,
): Promise<TResult> => {
  let raw: TResult;
  try {
    raw = await def.execute(ctx, args);
  } catch (err) {
    if (err instanceof OcrError) throw err;
    throw new OcrError("INTERPRETATION_FAILED", `${def.key} execution failed`, {
      retryable: false,
      details: err instanceof Error ? err.message : String(err),
    });
  }

  const parsed = resolveResultSchema(def, args).safeParse(raw);
  if (!parsed.success) {
    throw new OcrError("SCHEMA_VALIDATION_FAILED", `${def.key} produced an invalid result`, {
      retryable: false,
      details: parsed.error.issues,
    });
  }
  return parsed.data;
};

const parseArgs = <TArgs, TResult>(def: OcrFunctionDefinition<TArgs, TResult>, raw: unknown): TArgs => {
  const parsed = def.argsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new OcrError("INVALID_ARGS", "Invalid function arguments", {
      retryable: false,
      details: parsed.error.issues,
    });
  }
  return parsed.data;
};

/** Runs only stages 1–2, producing the canonical document (used for cache warming / debugging). */
export const extract = async <TArgs, TResult>(
  def: OcrFunctionDefinition<TArgs, TResult>,
  req: OcrRequest,
  deps: PipelineDeps,
): Promise<RecognizedDocument> => {
  const input = await ingest(req);
  const opts: RecognizeOptions = { requestId: req.requestId, userIdHash: req.tenantId };
  const { doc } = await extractDocument(def, input, opts, deps);
  return doc;
};
