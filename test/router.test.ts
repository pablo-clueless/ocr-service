import { describe, expect, it } from "vitest";

import { providerSatisfies, routeProvider } from "../src/providers/router";
import { defaultProviderPolicy } from "../src/config/providers";
import type {
  Capability,
  DocumentInput,
  MimeGroup,
  OcrProvider,
  RecognizedDocument,
  RecognizeOptions,
} from "../src/providers/types";

/** Minimal fake provider — the router only inspects name/accepts/capabilities. */
const fakeProvider = (name: string, accepts: MimeGroup[], capabilities: Capability[]): OcrProvider => ({
  name,
  accepts,
  capabilities,
  recognize: async (_input: DocumentInput, _opts: RecognizeOptions): Promise<RecognizedDocument> => {
    throw new Error("not used in routing tests");
  },
});

const glm = fakeProvider("glm-ocr", ["pdf", "image"], ["text", "layout", "tables", "handwriting", "seals"]);
const tesseract = fakeProvider("tesseract", ["image", "pdf"], ["text", "layout"]);
const pdfText = fakeProvider("pdf-text", ["pdf"], ["text"]);
const plainText = fakeProvider("plain-text", ["text"], ["text"]);
const mammoth = fakeProvider("mammoth", ["docx"], ["text", "tables"]);

const registry = [plainText, pdfText, mammoth, tesseract, glm];

describe("providerSatisfies", () => {
  it("requires the group and every capability", () => {
    expect(providerSatisfies(glm, "image", ["seals"])).toBe(true);
    expect(providerSatisfies(tesseract, "image", ["seals"])).toBe(false);
    expect(providerSatisfies(tesseract, "docx", ["text"])).toBe(false);
  });
});

describe("routeProvider", () => {
  it("routes images to GLM primary with Tesseract fallback", () => {
    const { provider, fallbacks } = routeProvider(registry, {
      group: "image",
      required: ["text"],
      fn: "DOCUMENT_CLASSIFICATION",
      policy: defaultProviderPolicy,
    });
    expect(provider.name).toBe("glm-ocr");
    expect(fallbacks.map((p) => p.name)).toContain("tesseract");
  });

  it("honors the TEXT_EXTRACTION override (Tesseract primary for images)", () => {
    const { provider, fallbacks } = routeProvider(registry, {
      group: "image",
      required: ["text"],
      fn: "TEXT_EXTRACTION",
      policy: defaultProviderPolicy,
    });
    expect(provider.name).toBe("tesseract");
    expect(fallbacks.map((p) => p.name)).toContain("glm-ocr");
  });

  it("filters out providers lacking a required capability (seals ⇒ only GLM)", () => {
    const { provider, fallbacks } = routeProvider(registry, {
      group: "image",
      required: ["layout", "seals"],
      fn: "SIGNING",
      policy: defaultProviderPolicy,
    });
    expect(provider.name).toBe("glm-ocr");
    // Tesseract lacks `seals`, so it must not appear even as a fallback.
    expect(fallbacks.map((p) => p.name)).not.toContain("tesseract");
  });

  it("prefers the digital text layer for text-only PDFs", () => {
    const { provider } = routeProvider(registry, {
      group: "pdf",
      required: ["text"],
      fn: "TEXT_EXTRACTION",
      policy: defaultProviderPolicy,
    });
    expect(provider.name).toBe("pdf-text");
  });

  it("skips pdf-text for PDFs needing layout", () => {
    const { provider } = routeProvider(registry, {
      group: "pdf",
      required: ["layout"],
      fn: "SIGNING",
      policy: defaultProviderPolicy,
    });
    expect(provider.name).toBe("glm-ocr");
  });

  it("routes DOCX to mammoth always", () => {
    const { provider } = routeProvider(registry, {
      group: "docx",
      required: ["text"],
      fn: "TEXT_EXTRACTION",
      policy: defaultProviderPolicy,
    });
    expect(provider.name).toBe("mammoth");
  });

  it("throws when no provider satisfies the request", () => {
    // GLM absent (disabled): nothing offers `seals`.
    const noSeals = [plainText, pdfText, mammoth, tesseract];
    expect(() =>
      routeProvider(noSeals, { group: "image", required: ["seals"], fn: "SIGNING", policy: defaultProviderPolicy }),
    ).toThrow(/No provider satisfies/);
  });
});
