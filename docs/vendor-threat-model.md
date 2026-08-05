# Vendor Threat Model & Vetting Note

The build takes runtime dependencies on two external vendors. The decision record flags
this as the sharpest one-way-door risk (Q4 vendor lock-in, Q6 security). This note records
what data reaches each vendor, the trust assumptions, and the mitigations — the "short
threat model / vetting note before GLM handles PII" that decision-record Q6 asks for.

> **Status:** draft — needs sign-off from the (still unnamed) owning team before the
> decision record moves to `accepted`.

## Vendors and data flow

| Vendor             | Role                                              | Data sent                                                                           | Enabled by                  |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| **Azure OpenAI**   | Per-function interpretation (structured output)   | The **extracted** document (markdown/text) + the function prompt. Not the raw file. | `AZURE_OPENAI_ENABLED=true` |
| **GLM-OCR** (z.ai) | Layout-aware extraction (OCR, seals, handwriting) | The **raw file bytes** (PDF/image)                                                  | `GLM_ENABLED=true`          |

Everything else — plain text, PDF text, DOCX, Tesseract image OCR, tamper analysis, MRZ —
runs **in-process** and sends nothing to a third party.

## Trust boundary & what crosses it

The document content crosses the process boundary to a vendor at two points:

1. **Extraction → GLM** (raw bytes). GLM sees the document as a human would: full fidelity,
   including any PII in the image.
2. **Interpretation → Azure** (extracted text). Azure sees the transcribed content, not the
   original pixels/bytes.

Both are TLS in transit. Neither vendor is under our operational control, so the residual
risk is **vendor-side handling** (retention, training use, sub-processors, region).

## The PII concern (the load-bearing one)

`ID_VERIFICATION` is the only `pii` function today, and it is the crux:

- ✅ **PII never enters the async queue.** `POST /v1/ocr/:function` gates async on
  `sensitivity === "standard"` ([`src/http/routes.ts`](../src/http/routes.ts)), so a `pii`
  file is never persisted to Redis. It runs inline and its bytes are held only in memory.
- ✅ **PII is not cached.** Extraction caching is disabled for sensitive functions, so a
  government ID never lands in the Redis extraction cache.
- ✅ **PII is not logged or traced.** `createRedactingLogger` + trace body-capture disabled
  for sensitive functions (enforced centrally in [`src/pipeline.ts`](../src/pipeline.ts)).
- ⚠️ **But `ID_VERIFICATION` requires `text` only, so it does _not_ route to GLM today** —
  it uses in-process text/Tesseract extraction, then Azure for the MRZ/interpretation step.
  So **the raw ID image does not currently reach GLM.** The extracted text (which contains
  the ID fields) does reach **Azure**.

**Open risk:** the moment a `pii` function requires `layout`/`seals` (routing it to GLM), or
GLM is made the image primary, **raw PII images will flow to GLM**. That must not ship
without: (a) a signed DPA / retention-off confirmation from the vendor, or (b) pointing
`GLM_BASE_URL` at a **self-hosted** GLM endpoint for data residency. This is the trigger
condition, not a today problem — but it is one config change away, so it is written down here.

## Mitigations in place

| Risk                     | Mitigation                                                                                                                     | Where                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Vendor lock-in           | `OcrProvider` interface + `GLM_BASE_URL` swappable → self-host or swap provider without touching interpretation                | `src/providers/`                                          |
| Secret exposure          | Vendor keys are env-only, never logged; config fails closed (enable-without-key throws at boot)                                | `src/config/env.ts`                                       |
| Over-broad data to Azure | Azure receives extracted text, not raw files; sensitive-function redaction keeps it out of our own logs/traces                 | `src/pipeline.ts`                                         |
| PII to the queue/cache   | Async + extraction-cache gated to `standard` sensitivity                                                                       | `src/http/routes.ts`                                      |
| Runaway spend / abuse    | Per-tenant rate limit; bounded provider concurrency (`GLM_CONCURRENCY`, `p-limit`); `ocr_tokens_used_total` for spend alerting | `src/http/middleware/rate-limit.ts`, `src/providers/glm/` |

## Vetting checklist (before GLM is on the PII path)

- [ ] Signed DPA with z.ai / GLM vendor; confirm **no training on submitted data** and a
      defined retention window (ideally zero-retention).
- [ ] Confirm data-processing **region** meets residency requirements; if not, stand up the
      self-hosted GLM endpoint and point `GLM_BASE_URL` at it.
- [ ] Same DPA/retention confirmation for **Azure OpenAI** (Azure's "no training / opt-out"
      terms — verify the deployment's data-handling tier).
- [ ] Name the owner accountable for this vetting (ties to decision-record Q9 owner gap).
- [ ] Re-review this note whenever a new `pii`/`restricted` function is added or a function's
      `requires` changes to pull in a vendor path.

## Summary

Today's exposure is bounded: **no raw PII reaches an external OCR vendor** (GLM), and
extracted PII reaches only Azure, kept out of our logs, traces, cache, and queue. The
one-way-door risk is **future**: wiring GLM into a `pii`/layout path. The mitigations
(self-host via `GLM_BASE_URL`, provider interface, sensitivity gating) are designed in;
what remains is the **paperwork** (DPAs, retention terms, a named owner) — required before
GLM handles PII, not before launch of the current `standard`-only vendor usage.
