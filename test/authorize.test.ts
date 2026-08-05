import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { authorizeFunction } from "../src/http/middleware/authorize";
import { OcrError } from "../src/http/errors";

const reqWith = (allowedFunctions: string[] | undefined, fn: string): Request =>
  ({
    tenant: allowedFunctions === undefined ? {} : { allowedFunctions },
    params: { function: fn },
  }) as unknown as Request;

const res = {} as Response;

describe("authorizeFunction", () => {
  it("allows any function when the tenant has no allow-list", () => {
    const next = vi.fn();
    authorizeFunction(reqWith(undefined, "ID_VERIFICATION"), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("allows any function when the allow-list is empty", () => {
    const next = vi.fn();
    authorizeFunction(reqWith([], "ID_VERIFICATION"), res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("allows a function that is on the allow-list", () => {
    const next = vi.fn();
    authorizeFunction(reqWith(["RECEIPT_PARSING", "TEXT_EXTRACTION"], "RECEIPT_PARSING"), res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("forbids a function that is not on the allow-list", () => {
    const next = vi.fn();
    authorizeFunction(reqWith(["RECEIPT_PARSING"], "ID_VERIFICATION"), res, next);
    const err = next.mock.calls[0]![0] as unknown;
    expect(err).toBeInstanceOf(OcrError);
    expect((err as OcrError).code).toBe("FORBIDDEN");
    expect((err as OcrError).status).toBe(403);
  });
});
