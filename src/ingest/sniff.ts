import { fromBuffer } from "file-type";
import { createHash } from "crypto";

import type { MimeGroup } from "../providers/types";

/**
 * Magic-byte content sniffing. Never trust
 * `req.file.mimetype` or the extension: a `.pdf` that's actually a JPEG must be
 * routed as an image, and a `.pdf` that's actually a ZIP must be rejected.
 */
export type SniffResult = {
  mime: string;
  mimeGroup: MimeGroup;
  ext: string;
};

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** MIME → coarse group used by providers and the router. */
export const toMimeGroup = (mime: string): MimeGroup | undefined => {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === DOCX_MIME) return "docx";
  if (mime === "text/plain" || mime === "text/markdown") return "text";
  return undefined;
};

/**
 * Detects the true type from buffer magic bytes. Returns `undefined` when the
 * type is unrecognized or unsupported so the caller can reject with
 * `UNSUPPORTED_MEDIA_TYPE`.
 *
 * `file-type` sniffs binary formats (PDF, images, DOCX-as-ZIP) but not plain
 * text, which has no signature — so a miss on a valid UTF-8 buffer is treated
 * as `text/plain`.
 */
export const sniff = async (buffer: Buffer): Promise<SniffResult | undefined> => {
  const detected = await fromBuffer(buffer);

  if (detected) {
    // DOCX is a ZIP under the hood; file-type reports `docx` for OOXML.
    const mime = detected.ext === "docx" ? DOCX_MIME : detected.mime;
    const mimeGroup = toMimeGroup(mime);
    return mimeGroup ? { mime, mimeGroup, ext: detected.ext } : undefined;
  }

  if (isProbablyText(buffer)) {
    return { mime: "text/plain", mimeGroup: "text", ext: "txt" };
  }
  return undefined;
};

/**
 * Heuristic used only when `file-type` returns no signature. Tightened
 * (docs/regression-and-security.md V8) so an unrecognized *binary* isn't waved
 * through as text just because its first bytes happen to be NUL-free:
 *
 *  1. reject any NUL byte over a larger (4 KiB) sample;
 *  2. require the sample to decode as strict UTF-8 (no replacement chars);
 *  3. reject if too many bytes are non-printable control chars (> 10%).
 */
const TEXT_SAMPLE_BYTES = 4096;
const MAX_CONTROL_RATIO = 0.1;

const isProbablyText = (buffer: Buffer): boolean => {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, TEXT_SAMPLE_BYTES);
  if (sample.includes(0)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return false; // not valid UTF-8 → treat as binary
  }

  let control = 0;
  for (const byte of sample) {
    // Control chars except tab (0x09), LF (0x0a), CR (0x0d), form-feed (0x0c).
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) control++;
  }
  return control / sample.length <= MAX_CONTROL_RATIO;
};

/** SHA-256 of the buffer — the cache key and trace correlation id. */
export const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
