# Tamper detection — `DOCUMENT_AUTHENTICITY`

The `DOCUMENT_AUTHENTICITY` function tells a _legitimately filled_ document apart from a
_doctored_ one. It runs on the **raw bytes** with no OCR/LLM pass (`skipExtraction: true`)
and returns `TamperSignals`.

- **Filled** — a form completed the way it was designed to be: AcroForm/XFA field values
  entered, a signature added to a signature field, a flatten/print-to-PDF of a completed
  form. The base content is untouched; only the intended blanks changed.
- **Doctored** — content the document was **not** meant to expose to editing was altered:
  an amount painted over and retyped, a name spliced in, a date changed, a stamp/signature
  copy-pasted, a page swapped, an image region cloned.

The distinction is not "was it modified" — almost every real PDF was modified. It is
**"were the modifications confined to the intended, legitimate editing surface?"**

> ⚠️ **Scope honesty.** This is _heuristic authenticity signalling_, not forensic proof.
> It raises well-founded suspicion and catches lazy edits; it does **not** prove a
> document is genuine, and a competent forger who rebuilds and re-flattens the file can
> defeat every signal here. The result carries `assuranceLevel: "heuristic-only"` — never
> report a naked "authentic: true".

## Where it fits

Tamper analysis is a **cross-cutting signal**, not one more interpretation function. It
runs on the raw buffer because the evidence lives in container structure — the PDF object
graph, the JPEG quantization tables — which the canonical `RecognizedDocument`
deliberately throws away. The code is split so the analyzers are reusable:

```
src/
  authenticity/
    signals.ts    TamperSignals type + noisy-OR score/verdict aggregation
    pdf.ts        PDF structural analysis (pdf-lib + raw byte scan)
    image.ts      image editor fingerprints, XMP history, EXIF checks
    index.ts      dispatch by mime group
  functions/
    document-authenticity/   { args.ts, result.ts, execute.ts, index.ts }
```

`SIGNING` and `ID_VERIFICATION` are the natural consumers — their results are only
meaningful if the underlying document isn't forged.

## The result type

```ts
type TamperVerdict = "clean" | "suspicious" | "likely-doctored" | "inconclusive";

type TamperSignal = {
  code: string; // stable machine code, e.g. "PDF_POST_SIGNATURE_EDIT"
  severity: "info" | "low" | "medium" | "high";
  detail: string; // human-readable explanation
};

type TamperSignals = {
  verdict: TamperVerdict;
  score: number; // aggregated 0–1 suspicion — calibrate thresholds on a golden corpus
  signals: TamperSignal[];
  assuranceLevel: "heuristic-only";
  analyzer: "pdf" | "image" | "unsupported";
  notes?: string[]; // what was NOT checked, so `clean` is never mistaken for a full pass
};
```

Aggregation (`signals.ts`): any `high` signal ⇒ at least `suspicious`; corroborating
`medium` signals push to `likely-doctored`. Absence of signals is `clean` **but never
"authentic"** — the payload says so, and `notes[]` records which checks did not run.

## What it checks

### PDF (`authenticity/pdf.ts`)

- **Incremental-update / revision analysis** — every save-after-first-save appends a new
  cross-reference section and another `%%EOF`, so the marker count reveals how many
  revisions exist. A filled AcroForm has incremental updates too, but a doctored file's
  update rewrites a content stream or replaces a page object.
- **Digital-signature integrity (`/ByteRange`)** — bytes appended _after_ a signature's
  signed range mean content was added post-signing. This is deterministic and
  high-confidence — the strongest "doctored" signal available, flagged `high`.
- **Metadata / producer consistency** — `CreationDate` vs `ModDate` divergence, `ModDate`
  after a signature, and `/Producer`/`/Creator` mismatch (authored in "Microsoft Word",
  last written by "iLovePDF"/"Ghostscript"). Corroborating, not proof on their own.

### Image (`authenticity/image.ts`)

- **Editor fingerprints** — `Software`/XMP naming Photoshop, GIMP, or a phone editor.
- **XMP edit history** listing multiple editors.
- **Stripped-EXIF detection** on JPEG — missing EXIF on a purported camera photo.

## Filled vs. doctored — the decision, summarized

| Observation             | Filled (benign)                                | Doctored (flag)                                 |
| ----------------------- | ---------------------------------------------- | ----------------------------------------------- |
| PDF incremental updates | touch `/AcroForm` field values + `/AP` streams | rewrite `/Contents`, `/Page`, splice `/XObject` |
| Digital signature       | none, or covers final bytes                    | edits **after** `/ByteRange`                    |
| Metadata / producer     | consistent authoring pipeline                  | edited by a different tool after creation       |
| Image EXIF / software   | consistent, no editor software                 | Photoshop/GIMP; stripped EXIF                   |

## Deferred (deliberately not faked)

These raise the assurance ceiling but need heavier dependencies and corpus calibration.
Each analyzer's `notes[]` names what it did not check, so a `clean` verdict is never
mistaken for a full forensic pass.

- **Deep image forensics** — Error Level Analysis, double-JPEG artifacts, PRNU/noise,
  copy-move detection. Needs pixel decoding (a `sharp`-class dependency) and a calibrated
  fixture set of known-genuine vs. known-edited images.
- **Object-level PDF revision diffing** — classifying whether an incremental update
  touched form fields (benign) vs. page content (suspicious), and white-box/overlay
  detection (a filled rectangle drawn over an old value). Needs a full object-graph diff;
  the current tier counts and inspects revisions but does not diff their object contents.

Keep any deep-image tier behind a flag so the default path stays light, and **calibrate
thresholds on a golden corpus** of known-filled Nigerian forms and known-doctored
variants — false positives on legitimately-filled forms are the failure mode that erodes
trust fastest.

## Relationship to other functions

- **`SIGNING`** should surface a tamper block alongside its result — a "fully executed"
  verdict on a doctored document is worse than useless.
- **`ID_VERIFICATION`** already validates MRZ/NIN check digits deterministically; tamper
  signals on the ID image are a natural companion. Keep the honest
  `assuranceLevel: "document-content-only"` framing — tamper heuristics _narrow_
  suspicion, they don't establish identity.
