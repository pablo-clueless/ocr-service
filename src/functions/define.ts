import type { ZodType } from "zod";

import type { Capability, MimeGroup, RecognizedDocument } from "../providers/types";
import type { Logger } from "../observability/logger";
import type { LlmClient } from "../llm/azure";

/** The catalog of document functions. Add a key here + a folder to extend. */
export const OcrFunction = {
  SIGNING: "SIGNING",
  ID_VERIFICATION: "ID_VERIFICATION",
  DOCUMENT_CLASSIFICATION: "DOCUMENT_CLASSIFICATION",
  FORM_DATA_EXTRACTION: "FORM_DATA_EXTRACTION",
  RECEIPT_PARSING: "RECEIPT_PARSING",
  TEXT_EXTRACTION: "TEXT_EXTRACTION",
  RESUME_PARSING: "RESUME_PARSING",
  DOCUMENT_AUTHENTICITY: "DOCUMENT_AUTHENTICITY",
} as const;

export type OcrFunctionKey = (typeof OcrFunction)[keyof typeof OcrFunction];

/**
 * Drives middleware, not documentation: `pii` functions get no raw
 * text in logs, no trace body capture, no result caching, and short-TTL buffers.
 */
export type Sensitivity = "standard" | "pii" | "restricted";

/** Everything a function's `execute` receives. Extraction is already done. */
export type OcrContext = {
  doc: RecognizedDocument;
  /** Raw uploaded bytes — needed by functions that analyze the container itself (tamper detection). */
  file: { sha256: string; mimeGroup: MimeGroup; sizeBytes: number; originalName: string; buffer: Buffer };
  requestId: string;
  tenantId: string;
  llm: LlmClient;
  logger: Logger;
};

export type OcrFunctionDefinition<TArgs, TResult> = {
  key: OcrFunctionKey;
  description: string;
  accepts: readonly MimeGroup[];
  requires: readonly Capability[];
  sensitivity: Sensitivity;
  maxPages: number;
  /**
   * Skip the extraction stage entirely. For functions that work on the raw
   * container bytes (e.g. DOCUMENT_AUTHENTICITY) and don't need OCR text — avoids
   * a pointless (and slow) OCR pass. `ctx.doc` is then an empty document.
   */
  skipExtraction?: boolean;
  argsSchema: ZodType<TArgs>;
  /** Static, or a function of args for dynamic-schema functions like FORM_DATA_EXTRACTION. */
  resultSchema: ZodType<TResult> | ((args: TArgs) => ZodType<TResult>);
  execute: (ctx: OcrContext, args: TArgs) => Promise<TResult>;
};

/**
 * Declares an OCR function with inferred arg and result types.
 *
 * @param def - The function definition.
 * @returns The same definition, type-narrowed for registry lookup.
 * @example
 * export const receiptParsing = defineOcrFunction({
 *   key: OcrFunction.RECEIPT_PARSING,
 *   description: "Parse a receipt into structured line items and totals.",
 *   accepts: ["pdf", "image"],
 *   requires: ["text", "tables"],
 *   sensitivity: "standard",
 *   maxPages: 5,
 *   argsSchema: receiptArgsSchema,
 *   resultSchema: receiptResultSchema,
 *   execute: async (ctx, args) => parseReceipt(ctx, args),
 * });
 */
export const defineOcrFunction = <TArgs, TResult>(
  def: OcrFunctionDefinition<TArgs, TResult>,
): OcrFunctionDefinition<TArgs, TResult> => def;

/** Resolves the result schema whether it's static or args-dependent. */
export const resolveResultSchema = <TArgs, TResult>(
  def: OcrFunctionDefinition<TArgs, TResult>,
  args: TArgs,
): ZodType<TResult> => (typeof def.resultSchema === "function" ? def.resultSchema(args) : def.resultSchema);
