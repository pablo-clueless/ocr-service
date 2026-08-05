import type { RecognizedDocument } from "./providers/types";
import { logger } from "./observability/logger";
import { getRedis } from "./redis";

/**
 * Extraction-layer cache. Cache extraction, never interpretation:
 * the same PDF hitting DOCUMENT_CLASSIFICATION then RECEIPT_PARSING pays for
 * GLM-OCR once. Skip entirely for `sensitivity: "pii"`.
 *
 * Key: `ocr:extract:{sha256}:{provider}:{pageRange}`. Redis, TTL ~7 days.
 */
export const extractionCacheKey = (sha256: string, provider: string, pageRange?: [number, number]): string =>
  `ocr:extract:${sha256}:${provider}:${pageRange ? `${pageRange[0]}-${pageRange[1]}` : "all"}`;

export interface ExtractionCache {
  get(key: string): Promise<RecognizedDocument | undefined>;
  set(key: string, doc: RecognizedDocument, ttlSeconds: number): Promise<void>;
}

/** No-op cache. Always misses. Used in tests and as the disabled-cache default. */
export const noopCache: ExtractionCache = {
  get: async () => undefined,
  set: async () => {},
};

/**
 * Redis-backed {@link ExtractionCache} over the shared client (`env.REDIS_URL`).
 * {@link RecognizedDocument} is plain JSON (no Buffers), so store/load is
 * `JSON.stringify`/`parse`.
 *
 * **Fail-open, like the rate limiter:** the cache is a cost optimization, never a
 * dependency of correctness. Any Redis or deserialization error degrades to a
 * miss on `get` and a swallowed warning on `set` — a cache outage must never turn
 * into a request outage.
 */
export class RedisExtractionCache implements ExtractionCache {
  async get(key: string): Promise<RecognizedDocument | undefined> {
    try {
      const raw = await getRedis().get(key);
      if (raw === null) return undefined;
      return JSON.parse(raw) as RecognizedDocument;
    } catch (err) {
      logger.warn("extraction cache get failed — treating as miss", {
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async set(key: string, doc: RecognizedDocument, ttlSeconds: number): Promise<void> {
    try {
      await getRedis().set(key, JSON.stringify(doc), "EX", ttlSeconds);
    } catch (err) {
      logger.warn("extraction cache set failed — skipping", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
