import Redis from "ioredis";

import { logger } from "./observability/logger";
import { env } from "./config/env";

/**
 * Shared Redis connection (rate limiter now; extraction cache + BullMQ later).
 * A single lazily-created client is reused process-wide.
 *
 * `enableOfflineQueue: false` makes commands **reject immediately** when Redis
 * is unreachable rather than buffering — callers can then fail open fast instead
 * of hanging. The `error` handler prevents an unhandled-error crash; individual
 * call sites decide how to degrade.
 */
let client: Redis | undefined;

export const getRedis = (): Redis => {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      lazyConnect: false,
    });
    client.on("error", (err) => logger.warn("redis error", { err: err.message }));
  }
  return client;
};

/**
 * Resolves once the shared client is connected and writeable. Because commands
 * use `enableOfflineQueue: false`, a short-lived process (the provisioning CLIs)
 * would otherwise fire its first command before the socket is ready and get
 * "Stream isn't writeable" — noticeable against a remote/TLS Redis where connecting
 * takes longer than the immediate command. The long-running server doesn't need
 * this (it connects during boot). Rejects on timeout so a CLI fails fast.
 */
export const whenRedisReady = async (timeoutMs = 8000): Promise<void> => {
  const client = getRedis();
  if (client.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      reject(new Error(`Redis not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    client.once("ready", onReady);
  });
};

/**
 * Closes the shared connection on graceful shutdown. `quit()` lets in-flight
 * commands drain before the socket closes; a no-op if the client was never
 * created. Safe to call more than once.
 */
export const closeRedis = async (): Promise<void> => {
  if (!client) return;
  const closing = client;
  client = undefined;
  await closing.quit();
};
