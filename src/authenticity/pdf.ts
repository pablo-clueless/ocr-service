import { PDFDocument } from "pdf-lib";

import type { TamperSignal, TamperSignals } from "./types";
import { aggregate } from "./signals";

/**
 * Deterministic PDF authenticity analysis (docs/tamper-detection.md). No external
 * services, no LLM — structure and metadata only. The strongest signal is a
 * post-signature edit (a digital signature that no longer covers the whole file);
 * incremental-update and metadata signals are softer context.
 *
 * NOT in this tier: object-level revision diffing (classifying whether an
 * incremental update touched form fields vs. page content) and overlay/redaction
 * detection. Those need a full PDF object-graph diff and are noted, not faked.
 */
const DEEP_TIER_NOTE =
  "Object-level revision diffing (form-field edits vs. page-content edits) and " +
  "white-box overlay detection are not performed in this tier.";

/** Producer strings that commonly indicate a PDF was re-written by an editor. */
const EDITOR_PRODUCERS = [
  "ilovepdf",
  "pdf-xchange",
  "pdfsam",
  "smallpdf",
  "sejda",
  "ghostscript",
  "foxit",
  "pdfescape",
  "nitro",
  "skia/pdf", // Chrome "Print to PDF"
];

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
};

export const analyzePdf = async (buffer: Buffer): Promise<TamperSignals> => {
  const signals: TamperSignal[] = [];
  const notes: string[] = [DEEP_TIER_NOTE];

  // latin1 preserves byte offsets so positions line up with buffer.length.
  const raw = buffer.toString("latin1");

  // --- Revision / incremental-update analysis ---
  const revisions = countOccurrences(raw, "%%EOF");
  const hasAcroForm = raw.includes("/AcroForm");
  const hasXfa = raw.includes("/XFA");

  if (hasAcroForm || hasXfa) {
    signals.push({
      code: "PDF_HAS_FORM",
      severity: "info",
      detail: `Document contains ${hasXfa ? "XFA" : "AcroForm"} form fields — incremental updates are expected when it is filled.`,
    });
  }

  if (revisions > 1) {
    signals.push({
      code: "PDF_MULTIPLE_REVISIONS",
      severity: "info",
      detail: `Saved ${revisions} times (incremental updates present). Normal for a filled form; suspicious only if a revision modified page content.`,
    });
  }

  // --- Digital signature integrity (the load-bearing signal) ---
  const byteRange = lastByteRange(raw);
  if (byteRange) {
    signals.push({
      code: "PDF_SIGNED",
      severity: "info",
      detail: "Contains a digital signature (/ByteRange present).",
    });

    const signedEnd = byteRange[2] + byteRange[3];
    // A properly signed file's second segment ends at (or within a few trailing
    // bytes of) EOF. Substantially more bytes = content appended after signing.
    if (buffer.length - signedEnd > 5) {
      signals.push({
        code: "PDF_POST_SIGNATURE_EDIT",
        severity: "high",
        detail:
          `${buffer.length - signedEnd} bytes were appended after the signed range — the signature no longer covers the whole document. ` +
          "Strong tampering indicator (unless the signature is a certification signature that permits form-filling).",
      });
    }
  }

  // --- Metadata / producer consistency ---
  try {
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true });
    const producer = (pdf.getProducer() ?? "").trim();
    const creator = (pdf.getCreator() ?? "").trim();

    const producerIsEditor = EDITOR_PRODUCERS.some((p) => producer.toLowerCase().includes(p));
    if (producer && creator && producer !== creator && producerIsEditor) {
      signals.push({
        code: "PDF_PRODUCER_CREATOR_MISMATCH",
        severity: "low",
        detail: `Authored by "${creator}" but last written by "${producer}" (a PDF-editing tool). Corroborating, not conclusive.`,
      });
    }

    const created = safeDate(() => pdf.getCreationDate());
    const modified = safeDate(() => pdf.getModificationDate());
    if (created && modified && modified.getTime() - created.getTime() > 1000) {
      signals.push({
        code: "PDF_MODIFIED_AFTER_CREATION",
        severity: "info",
        detail: `Modified (${modified.toISOString()}) after creation (${created.toISOString()}). Expected for a filled form; context only.`,
      });
    }
  } catch {
    notes.push("Structured PDF parse failed; only byte-level signals were computed.");
  }

  return aggregate("pdf", signals, notes);
};

/** Returns the last `/ByteRange [a b c d]` as a 4-tuple, or undefined. */
const lastByteRange = (raw: string): [number, number, number, number] | undefined => {
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let match: RegExpExecArray | null;
  let last: [number, number, number, number] | undefined;
  while ((match = re.exec(raw)) !== null) {
    last = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return last;
};

const safeDate = (fn: () => Date | undefined): Date | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
