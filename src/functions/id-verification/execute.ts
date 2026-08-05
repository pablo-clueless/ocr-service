import { z } from "zod";

import { buildIdVerificationPrompt } from "./prompt";
import { idVerificationResultSchema } from "./result";
import { idDocumentTypeSchema } from "./args";
import { parseMrz, type MrzFields } from "./mrz";
import type { IdVerificationArgs } from "./args";
import type { IdVerificationResult } from "./result";
import type { OcrContext } from "../define";

/**
 * The model extracts only the raw fields + document type — never the `checks`,
 * which are computed deterministically here. Asking the LLM to judge its own
 * check digits or expiry is exactly the silent-failure trap MRZ parsing exists
 * to avoid.
 */
const idExtractionSchema = z.object({
  documentType: idDocumentTypeSchema,
  fields: idVerificationResultSchema.shape.fields,
});
type IdExtraction = z.infer<typeof idExtractionSchema>;

/**
 * Extracts ID fields, parses MRZ deterministically, and computes the `checks`
 * block. When MRZ validates, prefer its fields over the LLM's for the fields it
 * covers. `assuranceLevel` is always "document-content-only" — this
 * is not identity assurance.
 *
 * Data residency: for `pii` this must route through a self-hosted GLM or Azure
 * vision, never the China-hosted GLM endpoint.
 */
export const executeIdVerification = async (
  ctx: OcrContext,
  args: IdVerificationArgs,
): Promise<IdVerificationResult> => {
  const { system, user } = buildIdVerificationPrompt(ctx.doc.markdown, args);

  const { data: extracted } = await ctx.llm.complete<IdExtraction>({
    system,
    user,
    schema: idExtractionSchema,
    schemaName: "ID_VERIFICATION_extraction",
  });

  const mrz = parseMrz(ctx.doc.markdown);
  const fields = mrz?.valid ? mergeMrzFields(extracted.fields, mrz.fields) : extracted.fields;

  const expiryDate = fields.expiryDate;
  const checks: IdVerificationResult["checks"] = {
    expiryDate,
    expired: expiryDate ? isExpired(expiryDate) : null,
    nameMatch: args.expected?.fullName != null ? looseMatch(fields.fullName, args.expected.fullName) : null,
    dobMatch: args.expected?.dateOfBirth != null ? datesMatch(fields.dateOfBirth, args.expected.dateOfBirth) : null,
    numberMatch:
      args.expected?.documentNumber != null ? alnumMatch(fields.documentNumber, args.expected.documentNumber) : null,
    mrzValid: mrz ? mrz.valid : null,
  };

  return {
    documentType: extracted.documentType,
    fields,
    checks,
    assuranceLevel: "document-content-only",
  };
};

type Fields = IdVerificationResult["fields"];

/** MRZ wins for the fields it covers, but only overwrites when it actually read a value. */
const mergeMrzFields = (llm: Fields, mrz: MrzFields): Fields => ({
  fullName: mrz.fullName ?? llm.fullName,
  dateOfBirth: mrz.dateOfBirth ?? llm.dateOfBirth,
  documentNumber: mrz.documentNumber ?? llm.documentNumber,
  expiryDate: mrz.expiryDate ?? llm.expiryDate,
  nationality: mrz.nationality ?? llm.nationality,
  sex: mrz.sex ?? llm.sex,
});

/** Parses ISO dates and 6-digit MRZ dates (YYMMDD) into a UTC Date, or null. */
const parseDateLoose = (value: string): Date | null => {
  const digits = value.replace(/\D/g, "");
  if (/^\d{6}$/.test(digits)) {
    const yy = Number(digits.slice(0, 2));
    // MRZ dates carry no century. Expiry/DOB heuristic: 00–50 → 2000s, else 1900s.
    const year = yy <= 50 ? 2000 + yy : 1900 + yy;
    const date = new Date(Date.UTC(year, Number(digits.slice(2, 4)) - 1, Number(digits.slice(4, 6))));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isExpired = (expiryDate: string): boolean | null => {
  const date = parseDateLoose(expiryDate);
  return date ? date.getTime() < Date.now() : null;
};

/** Case-insensitive, whitespace-collapsed name comparison. */
const looseMatch = (actual: string | null, expected: string): boolean => {
  if (actual == null) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(actual) === norm(expected);
};

/** Alphanumeric-only comparison (drops separators/case in document numbers). */
const alnumMatch = (actual: string | null, expected: string): boolean => {
  if (actual == null) return false;
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return norm(actual) === norm(expected);
};

/** Compares two dates by calendar day, tolerating ISO vs MRZ formats. */
const datesMatch = (actual: string | null, expected: string): boolean => {
  if (actual == null) return false;
  const a = parseDateLoose(actual);
  const b = parseDateLoose(expected);
  if (!a || !b) return false;
  return a.getTime() === b.getTime();
};
