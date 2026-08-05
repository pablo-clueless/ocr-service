import type { OcrFunctionKey } from "../functions/define";

/**
 * Fallback chains as config, not code. Provider names are matched
 * against `OcrProvider.name`. Per-function overrides let e.g. TEXT_EXTRACTION
 * prefer Tesseract on cheap high-volume paths while everything else prefers GLM.
 */
export type FallbackChain = {
  primary: string;
  fallbacks: string[];
};

export type ProviderPolicy = {
  image: FallbackChain;
  scannedPdf: FallbackChain;
  overrides?: Partial<Record<OcrFunctionKey, Partial<ProviderPolicy>>>;
};

/** Below this chars/page a PDF page is treated as scanned and re-routed to OCR. */
export const SCANNED_PDF_CHARS_PER_PAGE_THRESHOLD = 100;

export const defaultProviderPolicy: ProviderPolicy = {
  image: { primary: "glm-ocr", fallbacks: ["tesseract"] },
  scannedPdf: { primary: "glm-ocr", fallbacks: ["tesseract"] },
  overrides: {
    // High-volume cheap path: prefer Tesseract for plain text extraction.
    TEXT_EXTRACTION: {
      image: { primary: "tesseract", fallbacks: ["glm-ocr"] },
    },
  },
};

/** Merges a function's override (if any) onto the base policy. */
export const policyForFunction = (policy: ProviderPolicy, fn: OcrFunctionKey): ProviderPolicy => {
  const override = policy.overrides?.[fn];
  if (!override) return policy;
  return {
    image: override.image ?? policy.image,
    scannedPdf: override.scannedPdf ?? policy.scannedPdf,
    overrides: policy.overrides,
  };
};
