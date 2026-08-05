# Architecture

The reference for the OCR service's internals — how a request flows, what the layers
are, and how to extend the catalog.

## Organizing principle

> **Extraction is shared, interpretation is per-function.**

A caller picks a _function_ (e.g. `RECEIPT_PARSING`), uploads a file, and passes
function-specific args. Any supported input is normalized into one canonical
`RecognizedDocument` (markdown + layout blocks), then the function's `execute` step
interprets it. Adding a new function is additive: one folder under `src/functions/`,
one line in the registry.

## Request pipeline

```
POST /v1/ocr/:function
  file + args
      │
      ▼
  1. Ingest     multipart → sniff magic bytes → sha256 → validate against fn.accepts
  2. Extract    router picks provider by capability → recognize (with fallback) → cache
  3. Interpret  fn.execute(ctx, args)  ── Azure OpenAI structured output (per function)
  4. Validate   Zod result schema + business rules → typed result
```

The orchestration lives in one place — [`src/pipeline.ts`](../src/pipeline.ts) — so the
sync path and the async queue worker run the _identical_ code.

## Layers

| Layer          | Directory                 | Responsibility                                                            |
| -------------- | ------------------------- | ------------------------------------------------------------------------- |
| Ingestion      | `src/ingest/`             | `multer` memory upload + size cap; `file-type` magic-byte sniff; sha256   |
| Extraction     | `src/providers/`          | Each provider emits the same `RecognizedDocument` shape                   |
| Routing        | `src/providers/router.ts` | Match a function's required capabilities to a provider + fallback chain   |
| Interpretation | `src/functions/*/`        | Per-function args/result schemas, prompt, and `execute`                   |
| Authenticity   | `src/authenticity/`       | Deterministic tamper analysis on raw bytes (PDF + image)                  |
| LLM            | `src/llm/`                | Azure OpenAI structured-output wrapper; Zod → JSON Schema                 |
| HTTP           | `src/http/`               | Routes, error envelope, middleware (auth, authz, rate-limit, sensitivity) |
| Jobs           | `src/jobs/`               | BullMQ queue + worker for async (large/multi-page) requests               |
| Observability  | `src/observability/`      | Logger (with redaction), metrics, tracing                                 |

### The load-bearing type

Every provider returns this. It is the single contract the whole interpretation layer
is written against ([`src/providers/types.ts`](../src/providers/types.ts)):

```ts
type RecognizedDocument = {
  markdown: string; // canonical format — one prompt shape regardless of source
  plainText: string;
  pages: PageResult[];
  blocks: LayoutBlock[]; // normalized 0–1 bboxes; [] for text-only providers
  pageCount: number;
  provider: string;
  fellBackFrom?: string;
  tokensUsed?: number;
  durationMs: number;
};
```

### Providers

| Provider                      | Accepts                  | Capabilities                                       | File                      |
| ----------------------------- | ------------------------ | -------------------------------------------------- | ------------------------- |
| `PlainTextProvider`           | text                     | `text`                                             | `providers/plain-text.ts` |
| `PdfTextProvider` (pdf-parse) | pdf                      | `text`                                             | `providers/pdf-text.ts`   |
| `MammothProvider`             | docx                     | `text`, `tables`                                   | `providers/mammoth.ts`    |
| `TesseractProvider`           | image (+ rasterized pdf) | `text`, `layout`                                   | `providers/tesseract.ts`  |
| `GlmOcrProvider`              | pdf, image               | `text`, `layout`, `tables`, `handwriting`, `seals` | `providers/glm/`          |

Routing rules (see `router.ts` and `config/providers.ts`):

- **DOCX** → mammoth, always.
- **PDF, text-only need** → pdf-parse first, then the _per-page_ scanned heuristic
  (`< ~100 chars/page` ⇒ re-route that page to OCR).
- **PDF needing `layout`/`seals`** → straight to GLM-OCR.
- **Image** → GLM-OCR, fall back to Tesseract on error/timeout.

Fallback chains are config (`defaultProviderPolicy`), with per-function overrides.

## Function registry

Functions are declared with `defineOcrFunction` and collected in
[`src/functions/registry.ts`](../src/functions/registry.ts). `GET /v1/ocr/functions`
walks the registry and returns JSON Schema for args and result per function.

| Function                  | LLM step             | Requires             | Sensitivity |
| ------------------------- | -------------------- | -------------------- | ----------- |
| `TEXT_EXTRACTION`         | no                   | `text`               | standard    |
| `DOCUMENT_CLASSIFICATION` | yes                  | `text`               | standard    |
| `RECEIPT_PARSING`         | yes                  | `text`, `tables`     | standard    |
| `FORM_DATA_EXTRACTION`    | yes (dynamic schema) | `text`               | standard    |
| `RESUME_PARSING`          | yes                  | `text`               | standard    |
| `ID_VERIFICATION`         | yes + MRZ            | `text`               | **pii**     |
| `SIGNING`                 | vision               | `layout`, `seals`    | standard    |
| `DOCUMENT_AUTHENTICITY`   | no (raw bytes)       | — (`skipExtraction`) | standard    |

`sensitivity: "pii"` is declarative and drives middleware centrally, where it can't be
bypassed per call site: no raw text in logs (`createRedactingLogger`), no trace body
capture, `Cache-Control: no-store`, and no extraction caching.

### Adding a function

1. Create `src/functions/<name>/` with `args.ts` (Zod), `result.ts` (Zod), and
   `execute.ts`; add a `prompt.ts` if it uses the LLM.
2. Declare it with `defineOcrFunction`, setting `accepts`, `requires` (capabilities),
   `sensitivity`, and `maxPages`.
3. Register it in `src/functions/registry.ts`. The catalog, JSON Schemas, routing, and
   the pipeline pick it up with no further changes.

## Wiring status

The catalog, schemas, router, pipeline, HTTP layer, security middleware, **and both the
sync and async paths** are wired end-to-end. No integration seam is stubbed.

**The GLM-OCR provider is wired**, not stubbed. Client (`fetch` with bounded retry/backoff
on 429/5xx), PDF-page chunker (rasterize → parallel base64 calls), and response mapper
(`layout_parsing` → canonical `RecognizedDocument`) are all implemented, and the provider
is constructed in the composition root ([`src/providers/index.ts`](../src/providers/index.ts))
behind `GLM_ENABLED` — when off, it's absent from the registry and the router falls the
image/scanned-PDF chains to Tesseract. Our mapping/retry/orchestration logic is covered by
`test/glm.test.ts`. **Caveat:** those tests exercise our code against the documented
`layout_parsing` contract; the provider has not been validated against z.ai's live API —
do a smoke test with a real key before it carries production traffic (see
[glm-ocr.md](./glm-ocr.md)), and see [vendor-threat-model.md](./vendor-threat-model.md)
before any `pii` document routes to it.

**The async queue + worker are wired**, not stubbed. `POST /v1/ocr/:function` routes a
`standard`-sensitivity request over the size/page thresholds (`ASYNC_SIZE_THRESHOLD_BYTES`,
`ASYNC_PAGE_THRESHOLD`) to the BullMQ queue, returning `202` + a `statusUrl`; the worker
(`node build/worker.js`) runs the _identical_ `runPipeline` off-request, and
`GET /v1/ocr/jobs/:id` reports status/result scoped to the submitting tenant. Typed
`OcrError` codes survive the queue boundary (`encodeJobError`), and `pii`/`restricted`
files are never enqueued. Covered by `test/jobs.test.ts`.

**Observability is wired**, not stubbed: metrics are real `prom-client` series served at
`/metrics`, and tracing is real OpenTelemetry. Export is config-gated — traces ship over
OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (console in dev, otherwise spans are
created but not shipped). Per-request metrics cover both `success` and `error` outcomes.
Not yet fed: `recordConfidence` (no function emits a confidence SLI yet) and the
`ocr_estimated_cost_ngn` counter.

The LLM functions run against `AzureLlmClient` only when `AZURE_OPENAI_ENABLED=true`
and the deployment is configured; otherwise `complete` throws a clear config error
(surfaced as `INTERPRETATION_FAILED`). `TEXT_EXTRACTION` and `DOCUMENT_AUTHENTICITY`
need no LLM and work without it.
