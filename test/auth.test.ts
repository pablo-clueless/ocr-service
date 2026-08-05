import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { generateApiKey, hashApiKey } from "../src/auth/tenants";
import { auth } from "../src/http/middleware/auth";
import { OcrError } from "../src/http/errors";

describe("tenant key helpers", () => {
  it("hashApiKey is deterministic sha256 hex", () => {
    const a = hashApiKey("secret-key");
    const b = hashApiKey("secret-key");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("other")).not.toBe(a);
  });

  it("generateApiKey returns distinct high-entropy tokens", () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1).not.toBe(k2);
    // 32 random bytes as base64url → 43 chars.
    expect(k1).toHaveLength(43);
  });
});

describe("auth middleware", () => {
  it("rejects a request with no API key (before touching the store)", async () => {
    const req = { header: () => undefined } as unknown as Request;
    const next = vi.fn();
    await auth(req, {} as Response, next);

    const err = next.mock.calls[0]![0] as unknown;
    expect(err).toBeInstanceOf(OcrError);
    expect((err as OcrError).code).toBe("UNAUTHORIZED");
    // A request id is always stamped, even on rejection.
    expect((req as Request).requestId).toMatch(/^req_/);
  });
});
