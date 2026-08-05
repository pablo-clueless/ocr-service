---
title: "Decision Record: Build the Heirs OCR Service"
summary: The ten-question decision framework and 12-factor assessment applied to the Heirs OCR service, plus a plan to close the open process gaps.
status: draft
owner: <TEAM_OR_ROLE — see § Plan, item 1>
decision_class: one-way door
last_reviewed: 2026-07-30
---

# Decision Record: Build the Heirs OCR Service

This record runs the [Decision Framework](./decision-framework.md) against the choice to
**build and operate the Heirs OCR service** — a single Express service exposing a catalog
of document functions (extract, classify, parse, verify, authenticate).

It exists because the build is a **one-way door**: it stands up a new long-lived service,
commits to an auth model, and takes dependencies on two external vendors (Azure OpenAI,
GLM-OCR). The framework requires those to be answered _in writing_ with a second opinion.
Until this record existed, the engineering was largely sound but the decision was
"made in our head" — the anti-pattern the framework calls out.

## Decision classification

| Attribute      | Value                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Decision type  | **One-way door** (new service, auth model, vendor dependencies)                                           |
| Record type    | ADR (this document)                                                                                       |
| Reversibility  | Service is replaceable; the **public HTTP contract** and **vendor lock-in** are the hard-to-reverse parts |
| Second opinion | ☐ _pending — see § Plan, item 1_                                                                          |

---

## The ten questions

### 1. Does this solve the actual problem? ✅

**Problem:** consuming apps need structured data out of heterogeneous documents (PDF,
image, DOCX, text) without each team reimplementing OCR + LLM extraction.

The design maps directly to it: **extraction is shared, interpretation is per-function**
(`docs/architecture.md`). One canonical `RecognizedDocument` feeds every function, so a
new capability is one folder under `src/functions/` plus one registry line. The solution
follows the problem rather than the reverse.

### 2. Is there an existing solution in the organisation? ✅ (confirmed: none)

Confirmed by the requester: **no equivalent capability currently exists in the org.** This
clears the "reuse before adopt before build" bar — there is nothing internal to reuse.
Vendors _are_ reused where they are commodity (Azure OpenAI for interpretation, GLM-OCR
for layout-aware extraction); only the orchestration is built in-house.

### 3. Can it be simpler? ✅

The one load-bearing abstraction (`RecognizedDocument`) is what keeps the rest small:
providers converge on one shape, so interpretation is written once. `TEXT_EXTRACTION` and
`DOCUMENT_AUTHENTICITY` deliberately skip the LLM entirely. Deterministic paths (MRZ
checksums, receipt total reconciliation, tamper signals) avoid an LLM where math suffices.

- **Watch:** the four seams flagged in Q10 (GLM, async, metrics export, graceful shutdown)
  are now all resolved and test-covered; what remains is process/governance, not code.

### 4. Will it still make sense in two years? ✅

- **Boring, well-supported stack:** Express 5, Node 22+, Postgres, Redis, Zod, BullMQ, OpenTelemetry.
- **Additive extension model** means growth doesn't require re-architecture.
- **Vendor swap is designed in:** `GLM_BASE_URL` can point at a self-hosted endpoint for
  data residency; the `OcrProvider` interface means a provider can be replaced without
  touching interpretation.
- **Risk:** GLM-OCR is the newest/most niche dependency. Its self-host path is the
  mitigation and should be validated before it is on the critical path for PII.

### 5. Is it observable? ✅ (export is wired; two SLIs unfed)

- **Designed in, not bolted on:** structured JSON logs to stdout (`observability/logger.ts`),
  a `/metrics` Prometheus endpoint (real `prom-client` series), OpenTelemetry tracing
  (`observability/otel.ts`), `/healthz` + `/readyz` probes.
- **PII-aware redaction** is enforced centrally via `createRedactingLogger` — raw document
  text can't reach the log sink for `pii` functions.
- **Export is real, config-gated:** traces ship over OTLP/HTTP when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the earlier "in-memory only" note was stale docs,
  now corrected). Per-request metrics now record **both `success` and `error`** outcomes, so
  the error-rate SLI is populated, and the interpret-latency histogram measures real time.
- **Remaining:** `recordConfidence` (low-confidence quality SLI) and the estimated-cost
  counter are implemented but unfed — no function emits a confidence/cost signal yet.
  Wire them when a function produces those signals.

### 6. Is it secure? ✅ strong

- **Server-to-server only**, API-key auth; **only the sha256 of each key** is stored in
  Postgres, so a dump can't be replayed.
- **Least privilege:** `--functions` scopes a key; `ID_VERIFICATION` (PII) can be kept off
  keys that shouldn't touch it → `403 FORBIDDEN`.
- **CORS default-closed**, wildcard never used.
- **`sensitivity: "pii"` is declarative and centrally enforced:** no raw text in logs, no
  trace-body capture, `Cache-Control: no-store`, no extraction caching, and PII files are
  never persisted to the Redis queue (`http/routes.ts` gates async on `standard` only), and
  the extraction cache is skipped for `pii`.
- **Config fails closed:** enabling a vendor without its key throws at startup.
- **Follow-up:** the vendor threat model / vetting note is now written
  ([vendor-threat-model.md](./vendor-threat-model.md)) — no raw PII reaches GLM today; the
  one-way-door risk is wiring GLM into a `pii`/layout path, which needs a DPA or self-host
  first. Remaining: **owner sign-off** on that note (ties to Q4, Q9).

### 7. Is it backwards compatible? ✅ (greenfield — establish the contract)

No existing consumers to break — this is the v1. The relevant work is **forward**: the
`/v1/` prefix, the stable error envelope (typed codes, never a raw provider error), and
the self-describing `GET /v1/ocr/functions` catalog are the compatibility surface to
protect from here on. Treat any change to the error codes or the response envelope as a
versioned change from day one.

### 8. Can it be rolled back safely? ✅ (was a gap — now closed)

- **Good:** stateless processes, config-driven. Postgres is the system of record, but the
  schema is applied **additively** at boot (`CREATE TABLE IF NOT EXISTS`) with no destructive
  migrations, so deploys are reversible by redeploying the prior build without data loss.
- **Resolved:** the **HTTP server now shuts down gracefully.** `src/index.ts` handles
  `SIGTERM`/`SIGINT` — stop accepting connections, drain in-flight requests, flush traces,
  close the Postgres pool and Redis, with a 10s forced-exit fallback — mirroring the worker
  (`src/worker.ts`). A rolling deploy or rollback no longer cuts in-flight requests. 12-factor
  IX (disposability).

### 9. What is the operational cost? ⚠️ owner unnamed

- **Running cost:** one Redis instance and one Postgres instance, plus per-call spend on Azure OpenAI and GLM-OCR
  (usage-based, scales with volume). Concurrency is bounded (`GLM_CONCURRENCY`, `p-limit`)
  and extraction is cached on sha256 so the same document pays for OCR once.
- **Toil is low by design:** tenants provisioned/revoked at runtime with no redeploy.
- **Gap:** **no named owning team.** The framework requires an owner who agrees to operate
  it; the `owner` field here is still `<TEAM_OR_ROLE>`. The **ops runbook now exists**
  ([runbook.md](./runbook.md)) — topology, config, alerts, failure→remediation,
  shutdown/rollback, tenant admin. The remaining blocker is naming the owner (the runbook's
  own owner field is a placeholder too); required before this leaves draft.

### 10. What technical debt does this introduce? ⚠️ named here, not yet ticketed

Named explicitly (from `docs/architecture.md § Not yet wired`):

| Debt                                               | Where                         | Repayment trigger                                                                                                                  |
| -------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ~~GLM-OCR provider stubbed~~                       | `src/providers/glm/`          | **Resolved** — implemented + wired (`GLM_ENABLED`), covered by `test/glm.test.ts`; remaining: live-API smoke test + DPA before PII |
| ~~Async queue + worker + `GET /jobs/:id` unwired~~ | `src/jobs/`, `http/routes.ts` | **Resolved** — wired and covered by `test/jobs.test.ts`                                                                            |
| ~~Metrics/tracing export unwired~~                 | `src/observability/`          | **Resolved** — export was real; closed the error-outcome metric + latency-timing gaps (Q5)                                         |
| ~~HTTP graceful shutdown missing~~                 | `src/index.ts`                | **Resolved** — SIGTERM/SIGINT drain with forced-exit fallback (Q8)                                                                 |

The debt is a conscious, documented choice — which satisfies the letter of Q10. What's
missing is the other half: **tickets and dated triggers.** "Not yet wired" without a
ticket becomes invisible debt.

---

## 12-factor assessment

| #    | Factor              | Status    | Evidence / gap                                                                                                               |
| ---- | ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| I    | Codebase            | ✅        | Single repo, one `main` branch                                                                                               |
| II   | Dependencies        | ✅        | `package.json` + `pnpm-lock.yaml`; pnpm pinned and enforced via `preinstall` guard                                           |
| III  | Config              | ✅ strong | All config in env, Zod-validated at boot; invalid config throws (`config/env.ts`)                                            |
| IV   | Backing services    | ✅        | Postgres / Redis / Azure / GLM attached via URLs; `GLM_BASE_URL` swappable for data residency                                |
| V    | Build, release, run | ✅        | `build` (tsc) separate from `start` / `worker`                                                                               |
| VI   | Processes           | ✅        | Stateless; durable state in Postgres (tenants, admins, usage), ephemeral state in Redis (cache, queue, rate-limit, sessions) |
| VII  | Port binding        | ✅        | `server.listen(PORT)`                                                                                                        |
| VIII | Concurrency         | ✅        | Distinct `web` and `worker` process types                                                                                    |
| IX   | Disposability       | ✅        | Both entrypoints drain on SIGTERM/SIGINT (`src/index.ts`, `src/worker.ts`) with a forced-exit fallback                       |
| X    | Dev/prod parity     | ✅        | Multi-stage `Dockerfile` + `docker-compose.yml` (api + worker + redis + postgres); same image runs both process types        |
| XI   | Logs                | ✅        | JSON event stream to stdout; no file/rotation logic in-app                                                                   |
| XII  | Admin processes     | ✅        | `provision:tenant` CLI runs the same code + config                                                                           |

**Verdict: 12-factor compliant (12/12).** The two prior gaps are closed — HTTP graceful
shutdown (IX, also Q8) and a container manifest for dev/prod parity + a reproducible
artifact (X, V).

---

## Decision

**Proceed with the build.** The launch-blocking development gaps this record found (§ Plan B)
are now all closed and test-covered; the architecture answers questions 1–4, 6, and 7 well.
The only remaining open items are **process/governance** (§ Plan A: owner, second opinion,
cost threshold, framework doc links), not design or code flaws.

Record checklist (from the framework):

- [x] The problem, in one sentence — Q1.
- [x] Options considered — reuse (none available), subscribe (vendors, adopted for
      commodity parts), build (the orchestration). "Do nothing" rejected: teams
      reimplement OCR ad hoc.
- [x] The answers that drove the choice — above.
- [x] Chosen option, trade-offs, debt accepted — Q10 table.
- [ ] **Who approved it, and how it can be reversed** — pending owner + second opinion.

---

## Plan — resolve the decision-making & development-process conflicts

The framework itself ships with unresolved placeholders, and this record surfaced concrete
gaps. Close them in this order:

### A. Process conflicts (own the framework itself)

1. **Name the owner and get the second opinion.** Fill the `owner` field on this record and
   in `decision-framework.md` (currently `<TEAM_OR_ROLE>`). A one-way-door decision needs a
   named approver — resolve this first; it unblocks the record's final checkbox.
2. **Resolve the ADR-vs-RFC-vs-approval mapping.** The framework carries a
   `TODO(owner)`: which decision classes require an ADR, an RFC, or a lead's sign-off.
   Ratify the placeholder mapping (one-way door → ADR; cross-team → RFC) or replace it, then
   delete the TODO.
3. **Set the cost sign-off threshold.** Replace `<COST_SIGNOFF_THRESHOLD>` with a real
   number and name who signs off above it. Usage-based Azure + GLM spend (Q9) is exactly the
   recurring cost this guardrail is for.
4. **Create the missing referenced docs or drop the links.** The framework links to
   `principles.md`, `ownership-model.md`, `observability/`, `runbooks.md`, etc. Several
   don't exist yet. Either stub them or mark them as planned so the framework isn't linking
   into voids.

### B. Development gaps this record found (before prod launch) — ✅ all done

5. ✅ **Graceful shutdown on the HTTP server** (`src/index.ts`) — SIGTERM/SIGINT drain with
   a forced-exit fallback, mirroring the worker. Closes 12-factor IX and Q8.
6. ✅ **Observability gaps closed** — export was already real (OTLP + Prometheus); fixed the
   error-outcome metric and latency-timing gaps, with histograms no longer polluted by
   failures. Closes Q5. _(Deferred: feed `recordConfidence` + cost counter once a function
   emits those signals.)_
7. ✅ **Dockerfile / container manifest** — multi-stage `Dockerfile` + `docker-compose.yml`
   (api + worker + redis + postgres). Closes 12-factor X / V. _(Image build not yet run on a Docker host.)_
8. ✅ **The "Not yet wired" seams are wired and test-covered** (GLM + async), so the debt is
   repaid rather than merely ticketed — see the Q10 table.
9. ✅ **Ops runbook + threat/vendor-vetting note** written ([runbook.md](./runbook.md),
   [vendor-threat-model.md](./vendor-threat-model.md)) — Q9, Q6.

### Sequencing — what's left

All of section B (5–9) is done and green (63 tests). **Only section A (process/governance,
items 1–4) remains, and it needs decisions, not code:** name the owner + second opinion (1),
ratify the ADR/RFC mapping (2), set the cost sign-off threshold (3), fix the framework's
dangling doc links (4). When item 1 and the second opinion land, flip this record's status
from `draft` to `accepted`. Two code follow-ups remain deferred (not launch-blocking): the
GLM live-API smoke test + vendor DPA before PII, and feeding the confidence/cost SLIs.
