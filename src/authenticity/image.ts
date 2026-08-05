import type { TamperSignal, TamperSignals } from "./types";
import { aggregate } from "./signals";

/**
 * Deterministic image authenticity analysis (docs/tamper-detection.md), cheap
 * tier: metadata + container structure only, no pixel decoding. Catches images
 * that carry an editor's fingerprint or had their provenance metadata stripped.
 *
 * NOT in this tier (needs pixel decoding + a `sharp`-class dependency and corpus
 * calibration): Error Level Analysis, double-JPEG-compression artifacts,
 * PRNU/noise inconsistency, and copy-move forgery detection. Noted, not faked.
 */
const DEEP_TIER_NOTE = "Pixel-level forensics (ELA, double-JPEG, PRNU/noise, copy-move) are not enabled in this tier.";

/** Editor fingerprints found in EXIF/XMP/PNG-text segments. */
const EDITORS: { name: string; needles: string[] }[] = [
  { name: "Adobe Photoshop", needles: ["Adobe Photoshop", "Photoshop 3.0"] },
  { name: "GIMP", needles: ["GIMP"] },
  { name: "Adobe Illustrator", needles: ["Adobe Illustrator"] },
  { name: "Pixelmator", needles: ["Pixelmator"] },
  { name: "Canva", needles: ["Canva"] },
  { name: "Figma", needles: ["Figma"] },
  { name: "Inkscape", needles: ["Inkscape"] },
  { name: "Snapseed", needles: ["Snapseed"] },
  { name: "Lightroom", needles: ["Lightroom"] },
];

const SCAN_BYTES = 256 * 1024;
const EXIF_MARKER = "Exif\x00\x00";

export const analyzeImage = (buffer: Buffer): TamperSignals => {
  const signals: TamperSignal[] = [];
  const notes = [DEEP_TIER_NOTE];

  const head = buffer.subarray(0, SCAN_BYTES).toString("latin1");
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;

  // --- Editor fingerprint (the strongest cheap signal) ---
  const editor = EDITORS.find((e) => e.needles.some((n) => head.includes(n)));
  if (editor) {
    signals.push({
      code: "IMAGE_EDITOR_SOFTWARE",
      severity: "medium",
      detail: `Metadata names an image editor (${editor.name}). The image was opened/saved in editing software.`,
    });
  }

  // --- XMP edit history ---
  if (head.includes("xmpMM:History") || head.includes("stEvt:action")) {
    signals.push({
      code: "IMAGE_XMP_EDIT_HISTORY",
      severity: "low",
      detail: "XMP metadata records an edit history (xmpMM:History).",
    });
  }

  // --- Metadata presence ---
  const hasExif = head.includes(EXIF_MARKER);
  if (isJpeg && !hasExif && !editor) {
    signals.push({
      code: "IMAGE_NO_METADATA",
      severity: "low",
      detail:
        "JPEG has no EXIF metadata. Provenance can't be corroborated — metadata may have been stripped by an editor or export.",
    });
  }

  if (!isJpeg && !isPng) {
    notes.push("Unrecognized image container; only substring scanning was applied.");
  }

  return aggregate("image", signals, notes);
};
