# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Function catalog architecture** — `POST /v1/ocr/:function` with a shared
  extraction stage and per-function interpretation; `GET /v1/ocr/functions` returns
  JSON Schemas for args and result per function.
- **Functions**: `TEXT_EXTRACTION`, `DOCUMENT_CLASSIFICATION`, `RECEIPT_PARSING`,
  `FORM_DATA_EXTRACTION`, `RESUME_PARSING`, `ID_VERIFICATION`, `SIGNING`,
  `DOCUMENT_AUTHENTICITY`.
- **Extraction providers**: plain-text, `pdf-parse`, `mammoth` (DOCX), and Tesseract,
  behind a capability-matching router with fallback chains.
- **Interpretation layer** on Azure OpenAI structured outputs (`json_schema`),
  re-validated against Zod result schemas.
- **Deterministic post-validation**: MRZ checksum parsing (`ID_VERIFICATION`) and
  receipt total reconciliation (`RECEIPT_PARSING`).
- **`DOCUMENT_AUTHENTICITY`** deterministic tamper analysis (PDF structure/signature/
  metadata, image editor fingerprints/EXIF) with a `heuristic-only` assurance level.
- **Security**: Redis-backed API-key auth (hashed keys, no database, fail-closed),
  per-function authorization, per-tenant rate limiting (fail-open), `pii` handling
  (log/trace redaction, `no-store`, no caching), default-closed CORS, magic-byte type
  sniffing, and untrusted-content guards against document-borne prompt injection.
- **Tenant provisioning CLI** (`pnpm provision:tenant`) for runtime create/revoke.
- **Configuration** validated at startup via Zod (`src/config/env.ts`); `.env.example`
  documents every variable.

### Notes

Some integration seams are staged but not yet wired: the GLM-OCR provider, the Redis
extraction cache (a no-op cache is used until then), and the async BullMQ queue/worker
with its `GET /jobs/:id` lookup. See
[docs/architecture.md § Not yet wired](./docs/architecture.md#not-yet-wired).

[Unreleased]: https://github.com/
