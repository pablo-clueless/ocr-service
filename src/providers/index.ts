import { PlainTextProvider } from "./plain-text";
import { TesseractProvider } from "./tesseract";
import { PdfTextProvider } from "./pdf-text";
import { MammothProvider } from "./mammoth";
import type { OcrProvider } from "./types";
import { GlmClient } from "./glm/client";
import { GlmOcrProvider } from "./glm";
import { env } from "../config/env";

/**
 * Composition root for the extraction layer. Builds the concrete provider
 * instances and exposes them as the registry the router matches against.
 */
export const buildProviderRegistry = (): OcrProvider[] => {
  const providers: OcrProvider[] = [
    new PlainTextProvider(),
    new PdfTextProvider(),
    new MammothProvider(),
    new TesseractProvider(),
  ];

  // Gated behind GLM_ENABLED (docs/glm-ocr.md): when off, the provider is absent
  // from the registry and the router falls the image/scanned-PDF chains to
  // Tesseract. One env flip reverts a bad rollout.
  if (env.GLM_ENABLED === "true") {
    const glmClient = new GlmClient({ apiKey: env.GLM_API_KEY ?? "", baseUrl: env.GLM_BASE_URL });
    providers.push(new GlmOcrProvider(glmClient, env.GLM_CONCURRENCY));
  }

  return providers;
};

export const providerRegistry: OcrProvider[] = buildProviderRegistry();

export * from "./types";
