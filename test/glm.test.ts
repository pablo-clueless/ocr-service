import { afterEach, describe, expect, it, vi } from "vitest";

import { mapLayoutParsing, toBlocks, toPages } from "../src/providers/glm/mapper";
import { GlmClient, type LayoutParsingResponse } from "../src/providers/glm/client";
import { GlmOcrProvider } from "../src/providers/glm";
import type { DocumentInput, RecognizeOptions } from "../src/providers/types";

/**
 * GLM-OCR coverage. Verifies *our* logic against the documented `layout_parsing`
 * contract — response mapping, retry/backoff/error handling, and the provider's
 * chunking + request building. It does NOT hit z.ai's live API, so it proves the
 * client is correct given the contract, not that the contract still matches z.ai.
 */

// A minimal but shape-complete single-page response.
const page = (over: Partial<LayoutParsingResponse> = {}): LayoutParsingResponse => ({
  id: "resp_1",
  created: 0,
  model: "glm-ocr",
  md_results: "# Heading\n\nbody text",
  layout_details: [
    [
      { index: 0, label: "text", bbox_2d: [0, 0, 1, 0.1], content: "Heading", height: 20, width: 200 },
      { index: 1, label: "table", bbox_2d: [0, 0.2, 1, 0.5], content: "<table></table>", height: 100, width: 200 },
    ],
  ],
  data_info: { num_pages: 1, pages: [{ width: 800, height: 1200 }] },
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  request_id: "req_1",
  ...over,
});

describe("mapLayoutParsing — response → RecognizedDocument", () => {
  it("maps a single page: markdown, blocks, dims, tokens, provider/timing", () => {
    const doc = mapLayoutParsing([page()], { provider: "glm-ocr", durationMs: 42 });
    expect(doc.provider).toBe("glm-ocr");
    expect(doc.durationMs).toBe(42);
    expect(doc.pageCount).toBe(1);
    expect(doc.markdown).toBe("# Heading\n\nbody text");
    expect(doc.plainText).toBe(doc.markdown);
    expect(doc.tokensUsed).toBe(15);
    expect(doc.pages[0]).toMatchObject({ page: 1, width: 800, height: 1200 });
    expect(doc.blocks.map((b) => b.label)).toEqual(["text", "table"]);
    expect(doc.blocks[1]!.bbox).toEqual([0, 0.2, 1, 0.5]); // normalized bbox carries straight through
  });

  it("stitches multiple page-chunks: continuous page numbers, global block index, summed tokens", () => {
    const p1 = page({ md_results: "page one" });
    const p2 = page({ md_results: "page two", request_id: "req_2" });
    const doc = mapLayoutParsing([p1, p2], { provider: "glm-ocr", durationMs: 1 });

    expect(doc.pageCount).toBe(2);
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(doc.markdown).toBe("page one\n\npage two");
    // 2 blocks per page → globally re-indexed 0..3, page stamped 1,1,2,2.
    expect(doc.blocks.map((b) => b.index)).toEqual([0, 1, 2, 3]);
    expect(doc.blocks.map((b) => b.page)).toEqual([1, 1, 2, 2]);
    expect(doc.tokensUsed).toBe(30);
  });

  it("degrades an unknown block label to 'image' rather than throwing", () => {
    const resp = page({
      layout_details: [
        [{ index: 0, label: "seal", bbox_2d: [0, 0, 1, 1], content: "GLM future label", height: 1, width: 1 }],
      ],
    });
    expect(toBlocks(resp, 0)[0]!.label).toBe("image");
  });

  it("omits empty page markdown from the joined document", () => {
    const resp = page({ md_results: "  ", layout_details: [[]] });
    const doc = mapLayoutParsing([resp], { provider: "glm-ocr", durationMs: 0 });
    expect(doc.markdown).toBe("");
  });

  it("toPages keeps a defensive multi-page response's markdown on the first page only", () => {
    const resp = page({
      md_results: "combined md",
      data_info: {
        num_pages: 2,
        pages: [
          { width: 800, height: 1200 },
          { width: 810, height: 1210 },
        ],
      },
    });
    const pages = toPages(resp, 0);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.markdown).toBe("combined md");
    expect(pages[1]!.markdown).toBe("");
    expect(pages[1]).toMatchObject({ page: 2, width: 810, height: 1210 });
  });
});

describe("GlmClient — retry, backoff, error handling", () => {
  afterEach(() => vi.restoreAllMocks());

  const client = (over = {}) =>
    new GlmClient({ apiKey: "k", baseUrl: "https://glm.test/api", maxRetries: 2, timeoutMs: 1000, ...over });

  const okResponse = () =>
    new Response(JSON.stringify(page()), { status: 200, headers: { "content-type": "application/json" } });

  it("posts JSON with the bearer token to /layout_parsing and returns the parsed body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    const res = await client().layoutParsing({ model: "glm-ocr", file: "data:image/png;base64,AA==" });

    expect(res.model).toBe("glm-ocr");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://glm.test/api/layout_parsing");
    expect((init as RequestInit).method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("retries on a 503 then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }))
      .mockResolvedValueOnce(okResponse());
    const res = await client().layoutParsing({ model: "glm-ocr", file: "x" });
    expect(res.id).toBe("resp_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx and surfaces the status + body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("bad file", { status: 400, statusText: "Bad Request" }));
    await expect(client().layoutParsing({ model: "glm-ocr", file: "x" })).rejects.toThrow(/400.*bad file/s);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on client error
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 500 }));
    await expect(client().layoutParsing({ model: "glm-ocr", file: "x" })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("propagates a caller abort without retrying", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(client().layoutParsing({ model: "glm-ocr", file: "x" }, controller.signal)).rejects.toThrow();
  });
});

describe("GlmOcrProvider — orchestration", () => {
  const input = (mimeGroup: "image" | "pdf", buffer: Buffer): DocumentInput => ({
    buffer,
    mimeGroup,
    sha256: "deadbeef",
    originalName: mimeGroup === "pdf" ? "doc.pdf" : "doc.png",
  });

  // A real 1x1 PNG so the data-URI MIME sniff picks image/png.
  const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );

  it("sends an image as a single base64 data-URI call with the sniffed MIME", async () => {
    const calls: { model: string; file: string }[] = [];
    const fakeClient = {
      layoutParsing: vi.fn(async (req: { model: "glm-ocr"; file: string }) => {
        calls.push(req);
        return page();
      }),
    } as unknown as GlmClient;

    const provider = new GlmOcrProvider(fakeClient);
    const doc = await provider.recognize(input("image", PNG_1x1), {
      requestId: "req_abcdef",
      userIdHash: "tenanthash",
    });

    expect(fakeClient.layoutParsing).toHaveBeenCalledTimes(1);
    expect(calls[0]!.file.startsWith("data:image/png;base64,")).toBe(true);
    expect(doc.provider).toBe("glm-ocr");
  });

  it("passes request_id / user_id only when within the API's length bounds", async () => {
    const seen: Record<string, unknown>[] = [];
    const fakeClient = {
      layoutParsing: vi.fn(async (req: Record<string, unknown>) => {
        seen.push(req);
        return page();
      }),
    } as unknown as GlmClient;

    const provider = new GlmOcrProvider(fakeClient);
    // requestId too short (<6) → dropped; userIdHash within 6..128 → kept.
    await provider.recognize(input("image", PNG_1x1), {
      requestId: "abc",
      userIdHash: "tenanthash",
    } as RecognizeOptions);

    expect(seen[0]!.request_id).toBeUndefined();
    expect(seen[0]!.user_id).toBe("tenanthash");
  });
});
