# OCR Service

A single Express service that exposes a **catalog of document functions**. A caller
picks a function (parse this receipt, verify this ID, classify this document), uploads
a file, and passes function-specific arguments. Any supported input — PDF, image, DOCX,
plain text — is normalized into one canonical markdown + layout representation, then a
per-function interpretation step runs on top of it.

The organizing principle: **extraction is shared, interpretation is per-function.**
Adding a new capability means adding one folder under `src/functions/` and one registry
line — nothing else changes.

## Documentation

| Doc                                                    | What's in it                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](./docs/architecture.md)         | Layered design, providers, the function registry, and the request pipeline                   |
| [docs/glm-ocr.md](./docs/glm-ocr.md)                   | GLM-OCR integration reference — API contract, base64/chunking, data residency, updates       |
| [docs/tamper-detection.md](./docs/tamper-detection.md) | How `DOCUMENT_AUTHENTICITY` tells a **doctored** document from a legitimately **filled** one |
| [CHANGELOG.md](./CHANGELOG.md)                         | Notable changes per release                                                                  |

## How it works

```
POST /v1/ocr/:function   (multipart: file + args)
      │
  1. Ingest     sniff magic bytes → sha256 → validate type
  2. Extract    router → provider (GLM-OCR / Tesseract / pdf-parse / mammoth) → RecognizedDocument
  3. Interpret  function.execute(ctx, args)  → Azure OpenAI structured output
  4. Validate   Zod result schema + business rules → typed result
```

Extraction is cached (keyed on the file's sha256) so the same document hitting two
functions pays for OCR once. The orchestration lives in one place —
[`src/pipeline.ts`](./src/pipeline.ts) — so the sync path and the async queue worker run
the identical code.

## Functions

| Function                  | Does                                       | Notes                                                                       |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `TEXT_EXTRACTION`         | Raw markdown / plain text                  | No LLM. The cheap path + smoke test.                                        |
| `DOCUMENT_CLASSIFICATION` | Label a document                           | Page-1-only by default; composable for auto-routing.                        |
| `RECEIPT_PARSING`         | Merchant, items, totals                    | NGN default, 7.5% VAT, deterministic total reconciliation.                  |
| `FORM_DATA_EXTRACTION`    | Caller-defined fields                      | Dynamic schema; field-count/depth caps.                                     |
| `RESUME_PARSING`          | Contact, experience, education…            | Uses layout bboxes to fix two-column reading order.                         |
| `ID_VERIFICATION`         | NIN / passport / licence fields + checks   | **PII.** MRZ validated deterministically. Document-content-only assurance.  |
| `SIGNING`                 | Signature/seal detection, execution status | Needs GLM-OCR layout + seal strength.                                       |
| `DOCUMENT_AUTHENTICITY`   | Doctored-vs-filled tamper signals          | Deterministic (no OCR/LLM); PDF signature + metadata, image editor markers. |

`GET /v1/ocr/functions` returns the live catalog with JSON Schemas for args and result
per function.

## Authentication

The service is **server-to-server**: consuming apps call it from their **backend** with
a secret API key — never from browser JavaScript (which would expose the key).

```
Authorization: Bearer <api-key>        # or:  X-API-Key: <api-key>
```

Keys map to **tenants** held in Postgres. Only the sha256 of each key is stored, so a
database dump can't be replayed as credentials. Provision and revoke at runtime with no
redeploy:

```bash
pnpm provision:tenant create acme --rate 120 --functions RECEIPT_PARSING,TEXT_EXTRACTION
#   → prints the raw API key ONCE (store it now; it can't be recovered)
pnpm provision:tenant revoke <api-key>
```

`--functions` scopes a key to specific functions (omit for all) — e.g. keep
`ID_VERIFICATION` off keys that shouldn't touch PII. A disallowed call returns `403 FORBIDDEN`.

Because it's server-to-server, **CORS is default-closed** — backend callers ignore CORS,
and no browser origin is allowed unless you explicitly list it in `CORS_ALLOWED_ORIGINS`
(the wildcard `*` is never used). Set `AUTH_ENABLED=false` to bypass auth for local dev only.

## Admin console

A small operator UI is served by the same Express app at **`/admin`** — a static,
dependency-free page backed by JSON routes under `/admin/api`. It does two things:

- **Tenant management** — create (raw key shown once), enable/disable, revoke, and edit
  rate limits / allowed functions, without touching the CLI.
- **Observability** — request counts, error rate, tokens, provider fallbacks, a
  health/provider matrix, BullMQ queue depth + recent jobs, and per-tenant usage.

Access is by **named admin users** (stored in Postgres, like tenants; passwords hashed with
argon2) with three roles: `owner` (everything, incl. managing admins), `manager` (tenant
CRUD + observability), and `viewer` (read-only observability). Login sets an httpOnly
session cookie; the UI only renders what the role permits.

The **first owner is seeded automatically at startup** when the admin registry is empty
(idempotent — it never overwrites a changed password or a deleted account), using
`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`. So a fresh deploy just works: open
`http://localhost:8080/admin`, sign in, and **change the password**. Owners then manage
other admins from the UI.

A `provision:admin` CLI is also available for scripted management:

```bash
pnpm provision:admin list
pnpm provision:admin create --email a@x.com --role manager
pnpm provision:admin delete <email>
```

Session lifetime is set by `ADMIN_SESSION_TTL_SECONDS` (default 8h). Since `/admin` is
same-origin it needs no CORS entry; keep it on an internal network in production.

## API

```
GET  /v1/ocr/functions        catalog + JSON Schemas
POST /v1/ocr/:function         multipart: `file` (the document) + `args` (JSON string)
GET  /v1/ocr/jobs/:id          async job status + result
GET  /healthz  /readyz         liveness / readiness
```

All `/v1/ocr/*` routes require a valid API key (see [Authentication](#authentication)).

**Success**

```json
{
  "requestId": "req_01J...",
  "function": "RECEIPT_PARSING",
  "result": {},
  "meta": {
    "provider": "glm-ocr",
    "fellBackFrom": null,
    "pageCount": 1,
    "cached": false,
    "durationMs": 1830,
    "tokensUsed": 4210
  }
}
```

**Errors** — one envelope, typed codes, never a raw provider error:

```json
{ "error": { "code": "NO_TEXT_DETECTED", "message": "...", "requestId": "req_01J...", "retryable": false } }
```

Codes: `UNAUTHORIZED` · `FORBIDDEN` · `UNSUPPORTED_MEDIA_TYPE` · `FILE_TOO_LARGE` ·
`PAGE_LIMIT_EXCEEDED` · `INVALID_ARGS` · `NO_TEXT_DETECTED` · `EXTRACTION_FAILED` ·
`PROVIDER_UNAVAILABLE` · `INTERPRETATION_FAILED` · `SCHEMA_VALIDATION_FAILED` · `RATE_LIMITED`.

> The synchronous path is the one wired today. The async queue (`202 Accepted` +
> `statusUrl` for large/multi-page requests) and the `GET /jobs/:id` lookup are staged
> seams — see [docs/architecture.md § Not yet wired](./docs/architecture.md#not-yet-wired).

## Quickstart

```bash
pnpm install
cp .env.example .env     # then fill in keys
pnpm dev                 # nodemon
# or
pnpm build && pnpm start
```

Requires Node 22+, a Redis instance (extraction cache + queue + rate limiter + sessions),
a Postgres database (tenants, admin users, usage), and — to enable the LLM/GLM paths —
Azure OpenAI and GLM-OCR credentials. The Postgres schema is created idempotently at startup.

> If `GLM_ENABLED=true`, a `GLM_API_KEY` is required or the service throws at startup.
> Likewise `AZURE_OPENAI_ENABLED=true` requires `AZURE_OPENAI_API_KEY`. Set either flag
> to `false` to run without that dependency.

## Configuration

Environment is Zod-validated at startup in [`src/config/env.ts`](./src/config/env.ts) —
an invalid config throws immediately. Copy [`.env.example`](./.env.example) and fill it in.

| Var                                                                        | Default                        | Purpose                                                |
| -------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `PORT`                                                                     | `8080`                         | HTTP port                                              |
| `NODE_ENV`                                                                 | `development`                  | `development` \| `production` \| `test`                |
| `REDIS_URL`                                                                | **required** (no default)      | Extraction cache + BullMQ + rate limiter + sessions    |
| `DATABASE_URL`                                                             | **required** (no default)      | Postgres: tenants, admin users, usage counters         |
| `AUTH_ENABLED`                                                             | `true`                         | API-key auth; `false` bypasses (local dev only)        |
| `API_KEY_CACHE_TTL_SECONDS`                                                | `30`                           | In-memory TTL for validated keys                       |
| `CORS_ALLOWED_ORIGINS`                                                     | `` (closed)                    | Comma-separated browser origins; empty = no CORS       |
| `RATE_LIMIT_ENABLED`                                                       | `true`                         | Per-tenant rate limiting (fails open if Redis is down) |
| `RATE_LIMIT_MAX`                                                           | `60`                           | Requests per window                                    |
| `RATE_LIMIT_WINDOW_SECONDS`                                                | `60`                           | Rate-limit window                                      |
| `MAX_FILE_SIZE_BYTES`                                                      | 50 MB                          | Upload cap                                             |
| `ASYNC_PAGE_THRESHOLD`                                                     | `5`                            | Go async above this many pages                         |
| `ASYNC_SIZE_THRESHOLD_BYTES`                                               | 5 MB                           | Go async above this size                               |
| `EXTRACTION_CACHE_TTL_SECONDS`                                             | 7 days                         | Extraction cache TTL                                   |
| `AZURE_OPENAI_ENABLED`                                                     | `false`                        | Interpretation layer master switch                     |
| `AZURE_OPENAI_API_KEY` / `_ENDPOINT` / `_API_VERSION` / `_DEPLOYMENT_NAME` | —                              | Required when enabled                                  |
| `GLM_ENABLED`                                                              | `false`                        | GLM-OCR master switch                                  |
| `GLM_API_KEY`                                                              | —                              | Required when enabled                                  |
| `GLM_BASE_URL`                                                             | `https://api.z.ai/api/paas/v4` | Swap to a self-hosted URL for PII                      |
| `GLM_MAX_PAGES`                                                            | `30`                           | Chunk-size ceiling                                     |
| `GLM_CONCURRENCY`                                                          | `8`                            | Bounded parallel page calls                            |

## Project layout

```
src/
  config/         env (Zod) + provider policy + CORS
  auth/           Postgres-backed tenant / API-key + admin registry
  ingest/         multer upload + magic-byte sniff + sha256
  providers/      OcrProvider implementations (glm/ tesseract pdf-text mammoth plain-text) + router
  functions/      one folder per function: args, result, prompt, execute + registry
  authenticity/   deterministic tamper analysis (PDF + image)
  llm/            Azure OpenAI structured-output wrapper; Zod → JSON Schema
  http/           routes, error envelope, middleware
  jobs/           BullMQ queue + worker for async requests
  observability/  logger, metrics, tracing
  scripts/        provision-tenant CLI
docs/             see the table above
```
