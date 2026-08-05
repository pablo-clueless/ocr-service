import { describe, expect, it } from "vitest";

import { runPipeline, type OcrRequest, type PipelineDeps } from "../src/pipeline";
import { PlainTextProvider } from "../src/providers/plain-text";
import { MockLlmClient } from "../src/llm/azure";
import { noopCache } from "../src/cache";
import { defaultProviderPolicy } from "../src/config/providers";
import { logger } from "../src/observability/logger";
import { textExtraction } from "../src/functions/text-extraction";
import { documentClassification } from "../src/functions/document-classification";
import { signing } from "../src/functions/signing";
import { registry } from "../src/observability/metrics";
import { OcrError } from "../src/http/errors";
import type { DocumentInput, OcrProvider, RecognizedDocument, RecognizeOptions } from "../src/providers/types";

/** Sum of ocr_requests_total for a given outcome, across all label sets. */
const requestCount = async (outcome: "success" | "error"): Promise<number> => {
  const metric = registry.getSingleMetric("ocr_requests_total");
  if (!metric) return 0;
  const data = (await (metric as { get(): Promise<unknown> }).get()) as {
    values: { labels: Record<string, string>; value: number }[];
  };
  return data.values.filter((v) => v.labels.outcome === outcome).reduce((sum, v) => sum + v.value, 0);
};

// 1x1 transparent PNG — a real, sniffable image payload.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const doc = (provider: string, text: string): RecognizedDocument => ({
  markdown: text,
  plainText: text,
  pages: [{ page: 1, markdown: text }],
  blocks: [],
  pageCount: 1,
  provider,
  durationMs: 0,
});

const fakeProvider = (
  name: string,
  recognize: (input: DocumentInput, opts: RecognizeOptions) => Promise<RecognizedDocument>,
): OcrProvider => ({
  name,
  accepts: ["image", "pdf"],
  capabilities: ["text", "layout", "tables", "handwriting", "seals"],
  recognize,
});

const deps = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
  llm: new MockLlmClient(),
  logger,
  providers: [new PlainTextProvider()],
  cache: noopCache,
  policy: defaultProviderPolicy,
  ...overrides,
});

const request = (buffer: Buffer, args: unknown = {}, name = "doc.txt"): OcrRequest => ({
  file: { buffer, originalName: name },
  args,
  requestId: "req_test",
  tenantId: "tenant_test",
});

describe("runPipeline — extraction + interpretation", () => {
  it("runs the no-LLM TEXT_EXTRACTION path end to end", async () => {
    const outcome = await runPipeline(textExtraction, request(Buffer.from("Hello world")), deps());
    expect(outcome.result.text).toBe("Hello world");
    expect(outcome.meta.provider).toBe("plain-text");
    expect(outcome.meta.cached).toBe(false);
    expect(outcome.meta.pageCount).toBe(1);
  });

  it("rejects a file the function does not accept (UNSUPPORTED_MEDIA_TYPE)", async () => {
    // SIGNING accepts pdf/image only; a text upload is rejected before routing.
    await expect(
      runPipeline(signing, request(Buffer.from("plain text")), deps({ providers: [] })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("stamps fellBackFrom when the primary provider fails and a fallback succeeds", async () => {
    // TEXT_EXTRACTION override makes tesseract the image primary; make it throw.
    const providers = [
      fakeProvider("tesseract", async () => {
        throw new Error("primary boom");
      }),
      fakeProvider("glm-ocr", async () => doc("glm-ocr", "fallback text")),
    ];
    const outcome = await runPipeline(textExtraction, request(PNG_1x1, {}, "x.png"), deps({ providers }));
    expect(outcome.meta.provider).toBe("glm-ocr");
    expect(outcome.meta.fellBackFrom).toBe("tesseract");
    expect(outcome.result.text).toBe("fallback text");
  });

  it("throws EXTRACTION_FAILED when every provider in the chain fails", async () => {
    const providers = [
      fakeProvider("tesseract", async () => {
        throw new Error("boom-1");
      }),
      fakeProvider("glm-ocr", async () => {
        throw new Error("boom-2");
      }),
    ];
    await expect(runPipeline(textExtraction, request(PNG_1x1, {}, "x.png"), deps({ providers }))).rejects.toMatchObject(
      {
        code: "EXTRACTION_FAILED",
      },
    );
  });

  // DOCUMENT_CLASSIFICATION accepts pdf/image/docx (not text), so feed an image
  // and a fake provider that yields the page markdown the classifier reads.
  const classifierProviders = (markdown: string) => [fakeProvider("glm-ocr", async () => doc("glm-ocr", markdown))];

  it("runs the LLM DOCUMENT_CLASSIFICATION path via the mock client", async () => {
    const llm = new MockLlmClient(
      new Map([
        [
          "DOCUMENT_CLASSIFICATION_result",
          { label: "invoice", confidence: 0.92, alternatives: [], rationale: "Has line items and a total." },
        ],
      ]),
    );
    const outcome = await runPipeline(
      documentClassification,
      request(PNG_1x1, {}, "x.png"),
      deps({ llm, providers: classifierProviders("INVOICE\nTotal: 100") }),
    );
    expect(outcome.result.label).toBe("invoice");
    expect(outcome.result.confidence).toBeCloseTo(0.92);
  });

  it("records a success outcome in ocr_requests_total", async () => {
    const before = await requestCount("success");
    await runPipeline(textExtraction, request(Buffer.from("metrics ok")), deps());
    expect(await requestCount("success")).toBe(before + 1);
  });

  it("records an error outcome when the pipeline throws (error-rate SLI is populated)", async () => {
    const before = await requestCount("error");
    const providers = [
      fakeProvider("tesseract", async () => {
        throw new Error("boom-1");
      }),
      fakeProvider("glm-ocr", async () => {
        throw new Error("boom-2");
      }),
    ];
    await expect(
      runPipeline(textExtraction, request(PNG_1x1, {}, "x.png"), deps({ providers })),
    ).rejects.toBeInstanceOf(OcrError);
    expect(await requestCount("error")).toBe(before + 1);
  });

  it("collapses a low-confidence label to 'unknown' when the caller allows it", async () => {
    const llm = new MockLlmClient(
      new Map([
        [
          "DOCUMENT_CLASSIFICATION_result",
          { label: "invoice", confidence: 0.2, alternatives: [], rationale: "Unsure." },
        ],
      ]),
    );
    // defaults: minConfidence 0.5, allowUnknown true.
    const outcome = await runPipeline(
      documentClassification,
      request(PNG_1x1, {}, "x.png"),
      deps({ llm, providers: classifierProviders("ambiguous doc") }),
    );
    expect(outcome.result.label).toBe("unknown");
  });
});

describe("OcrError shape", () => {
  it("maps codes to HTTP statuses", () => {
    expect(new OcrError("NOT_FOUND", "x").status).toBe(404);
    expect(new OcrError("UNSUPPORTED_MEDIA_TYPE", "x").status).toBe(415);
  });
});
