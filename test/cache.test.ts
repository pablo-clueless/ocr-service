import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake shared Redis client, created via vi.hoisted so it exists before the
// hoisted vi.mock factory below references it.
const { fakeRedis, store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    fakeRedis: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
    },
  };
});

vi.mock("../src/redis", () => ({ getRedis: () => fakeRedis }));

import { RedisExtractionCache, extractionCacheKey, noopCache } from "../src/cache";
import type { RecognizedDocument } from "../src/providers/types";

const doc: RecognizedDocument = {
  markdown: "# Invoice",
  plainText: "Invoice",
  pages: [{ page: 1, markdown: "# Invoice", width: 800, height: 1200 }],
  blocks: [{ index: 0, page: 1, label: "text", bbox: [0, 0, 1, 1], content: "Invoice" }],
  pageCount: 1,
  provider: "tesseract",
  durationMs: 42,
};

describe("extractionCacheKey", () => {
  it("namespaces by sha256, provider, and page range", () => {
    expect(extractionCacheKey("abc123", "glm-ocr")).toBe("ocr:extract:abc123:glm-ocr:all");
    expect(extractionCacheKey("abc123", "glm-ocr", [1, 3])).toBe("ocr:extract:abc123:glm-ocr:1-3");
  });
});

describe("RedisExtractionCache", () => {
  const key = extractionCacheKey("abc123", "tesseract");

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("round-trips a RecognizedDocument through set → get", async () => {
    const cache = new RedisExtractionCache();
    await cache.set(key, doc, 60);
    expect(fakeRedis.set).toHaveBeenCalledWith(key, JSON.stringify(doc), "EX", 60);

    const hit = await cache.get(key);
    expect(hit).toEqual(doc);
  });

  it("returns undefined on a miss", async () => {
    const cache = new RedisExtractionCache();
    expect(await cache.get("ocr:extract:missing:tesseract:all")).toBeUndefined();
  });

  it("fails open to a miss when get throws (a cache outage must not fail the request)", async () => {
    fakeRedis.get.mockRejectedValueOnce(new Error("redis unreachable"));
    const cache = new RedisExtractionCache();
    expect(await cache.get(key)).toBeUndefined();
  });

  it("swallows set errors rather than propagating them", async () => {
    fakeRedis.set.mockRejectedValueOnce(new Error("redis unreachable"));
    const cache = new RedisExtractionCache();
    await expect(cache.set(key, doc, 60)).resolves.toBeUndefined();
  });
});

describe("noopCache", () => {
  it("always misses and accepts writes without storing", async () => {
    expect(await noopCache.get("anything")).toBeUndefined();
    await expect(noopCache.set("anything", doc, 60)).resolves.toBeUndefined();
  });
});
