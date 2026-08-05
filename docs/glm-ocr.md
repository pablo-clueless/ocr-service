# GLM-OCR integration

GLM-OCR is the **layout-aware extraction layer** — it turns images and scanned PDFs
into markdown + positioned layout blocks. It does **not** interpret; Azure OpenAI does
that. The two are complementary, not competing — do not plan a migration off Azure
OpenAI.

This document is the integration reference: the API contract, how the provider is
structured, and how to update it safely when the upstream API changes.

> The GLM provider is present but its network seams (`client` / `chunker` / `mapper`)
> are not yet connected — see [Provider structure](#provider-structure). Until then it
> is gated off by `GLM_ENABLED=false`, and image/PDF extraction falls to Tesseract.

## Why GLM-OCR

- **Seal/stamp recognition is its standout capability** (~90.5 on Zhipu's internal seal
  benchmark). For Nigerian corporate documents — company seals, stamped receipts,
  stamped affidavits — this is the single biggest reason to adopt it over Tesseract. It
  also leads on handwriting and real-world tables.
- Roughly an order of magnitude cheaper than traditional OCR (~¥0.2 / M tokens, input
  and output priced the same). **Cost is not the constraint; latency and page limits
  are.**

## API contract

- **Endpoint:** `POST {GLM_BASE_URL}/layout_parsing`
  Default `GLM_BASE_URL=https://api.z.ai/api/paas/v4` (international). Mainland host is
  `https://open.bigmodel.cn/api/paas/v4`. Use z.ai from Lagos.
- **Auth:** `Authorization: Bearer ${GLM_API_KEY}`
- **Not multipart.** `file` is a URL **or** a base64 data URI.

### Request (`LayoutParsingRequest`, `src/providers/glm/client.ts`)

| Field                           | Notes                                                                |
| ------------------------------- | -------------------------------------------------------------------- |
| `model`                         | `"glm-ocr"`                                                          |
| `file`                          | URL or `data:image/png;base64,...`                                   |
| `return_crop_images`            | cropped region screenshots — used by `SIGNING`                       |
| `need_layout_visualization`     | annotated page images — debug only                                   |
| `start_page_id` / `end_page_id` | 1-based inclusive PDF page range — the chunking lever                |
| `request_id`                    | 6–64 chars, unique — **put the job id here** for tracing/idempotency |
| `user_id`                       | 6–128 chars — send a **hashed** tenant id, never a raw one           |

### Response (`LayoutParsingResponse`)

`md_results` is the page markdown. `layout_details` is **an array per page**, each
holding that page's blocks:

```ts
type LayoutDetail = {
  index: number;
  label: "image" | "text" | "formula" | "table";
  bbox_2d: [number, number, number, number]; // normalized 0–1
  content: string; // table blocks return HTML here
  height: number;
  width: number;
};
```

### Limits (verify against your key)

| Limit          | Value                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Single image   | ≤ 10 MB                                                                                                                  |
| PDF            | ≤ 50 MB                                                                                                                  |
| Pages per call | **docs disagree: z.ai OpenAPI says 30, bigmodel guide says 100.** Design for 30 (`GLM_MAX_PAGES`, default 30) and chunk. |

> ⚠️ **There is no `prompt` parameter on the hosted `layout_parsing` API.** The
> promptable/KIE mode (`"Text Recognition:"`, `"Table Recognition:"`) only exists on the
> self-hosted model and the Ollama build. Third-party blogs showing a `prompt` field are
> wrong for this endpoint. GLM-OCR is extraction-only.

## Provider structure

The provider is split so each seam is independently testable
([`src/providers/glm/`](../src/providers/glm/)):

| File         | Responsibility                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.ts`  | `layoutParsing()` — `fetch` with the `Authorization` header, JSON body, bounded retry/backoff on 429 + 5xx, `AbortSignal` timeout                                              |
| `chunker.ts` | `splitPdfToPageImages()` renders each PDF page to a base64 PNG (via `pdf-to-img`); `mapWithConcurrency()` runs `p-limit`-bounded parallel calls (`GLM_CONCURRENCY`, default 8) |
| `mapper.ts`  | `mapLayoutParsing()` flattens `layout_details[page][block]` → `LayoutBlock[]`, offsetting page indices when merging chunks, and builds `pages` + `markdown`                    |
| `index.ts`   | `GlmOcrProvider.recognize()` — chunk → `mapWithConcurrency(client.layoutParsing)` → `mapLayoutParsing`                                                                         |

### Throughput guidance (drives the chunker design)

Zhipu benchmarks single-concurrency at 1.86 PDF pages/s and 0.67 images/s. A 20-page PDF
_serially_ is ~11s; split into 20 parallel image calls with bounded concurrency it's a
few seconds. So: **prefer images over file upload, split multi-page PDFs into parallel
page calls.** This is why the provider rasterizes pages and calls per page rather than
passing a whole PDF.

## Prefer base64 data URIs over URLs

Three problems, one decision — pass each page as a base64 PNG:

1. **No blob-store exposure.** A URL means the document must be fetchable by an external
   service (public, or a short-TTL signed URL). Base64 keeps it in the request body.
2. **Sidesteps the 50 MB PDF cap** — each page image is well under the 10 MB image cap.
3. **Sidesteps the page limit** — page-splitting is already the chunking strategy.

## Data residency (read before `ID_VERIFICATION` ships)

The hosted API is operated by Zhipu AI in China. Sending Nigerian NINs, passports, and
driver's licences there is a **cross-border personal-data transfer** under the Nigeria
Data Protection Act 2023 and needs a documented lawful basis _before_ it reaches a
client. Options, in order of preference:

1. **Self-host GLM-OCR for `pii`/`restricted` functions.** MIT-licensed, runs on a
   single 4 GB-VRAM GPU (vLLM/SGLang). The provider stays one implementation with a
   swapped `GLM_BASE_URL`. Cleanest answer, and the intended one — keep a written note
   of the data-flow decision for compliance.
2. Use Azure OpenAI vision for PII functions; reserve hosted GLM for non-PII.
3. Hosted GLM with a documented transfer basis + consent capture (legal dependency).

## Updating the integration safely

When you change the GLM version, host, or the request/response contract:

1. **Roll out in shadow mode first.** On a sampled % of image/scanned-PDF requests, run
   **both** GLM and Tesseract, serve Tesseract, log both outputs and their diff. OCR
   quality is workload-specific — Zhipu's benchmarks are not your Nigerian receipts and
   stamped forms. Shadow mode tells you what GLM is actually worth before it's
   load-bearing, at negligible cost.
2. **Pin and re-verify the limits** (`GLM_MAX_PAGES`) against your own key — the
   documented page cap is inconsistent.
3. **Keep the mapper defensive.** If the upstream adds or renames a `label`, unknown
   labels must map to a safe default (treat as `image` for geometry, keep `content`),
   not throw. A response-shape change should degrade, not 500.
4. **Watch `ocr_provider_fallback_total{from="glm-ocr"}`.** A rising GLM→Tesseract
   fallback rate is the early warning that the upstream is degrading — and it's invisible
   in the success rate because fallback _works_.
5. **Feature-flag it.** `GLM_ENABLED` gates the provider; a bad rollout is one env flip
   to revert to Tesseract-primary.

## Config

| Env               | Default                        | Purpose                         |
| ----------------- | ------------------------------ | ------------------------------- |
| `GLM_ENABLED`     | `false`                        | Master switch                   |
| `GLM_API_KEY`     | —                              | Required when enabled           |
| `GLM_BASE_URL`    | `https://api.z.ai/api/paas/v4` | Swap to self-hosted URL for PII |
| `GLM_MAX_PAGES`   | `30`                           | Chunk size ceiling              |
| `GLM_CONCURRENCY` | `8`                            | Bounded parallel page calls     |
