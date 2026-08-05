import { parse as parseMrzLines } from "mrz";

/**
 * Deterministic MRZ parsing. For passports the two machine-readable
 * lines carry check digits — validate the checksums with the `mrz` package
 * rather than asking the LLM to read them. An LLM hallucinating one digit is a
 * silent, plausible-looking failure. When MRZ validates, prefer its fields.
 */
export type MrzFields = {
  documentNumber: string | null;
  fullName: string | null;
  dateOfBirth: string | null;
  expiryDate: string | null;
  nationality: string | null;
  sex: string | null;
};

export type MrzParseResult = {
  valid: boolean;
  fields: MrzFields;
};

/** A candidate MRZ line after whitespace removal: MRZ charset, plausible length, filler present. */
const MRZ_LINE = /^[A-Z0-9<]{28,44}$/;

/** Locates and parses MRZ lines in the extracted text. Returns undefined if none present. */
export const parseMrz = (text: string): MrzParseResult | undefined => {
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, "").toUpperCase())
    .filter((line) => MRZ_LINE.test(line) && line.includes("<"));

  if (candidates.length < 2) return undefined;

  // MRZ sits at the bottom of the document. Try TD1 (3×30) then TD3/TD2 (2 lines);
  // the `mrz` parser validates line count and length for the detected format.
  const attempts: string[][] = [];
  if (candidates.length >= 3) attempts.push(candidates.slice(-3));
  attempts.push(candidates.slice(-2));

  for (const lines of attempts) {
    const parsed = tryParse(lines);
    if (parsed) return parsed;
  }
  return undefined;
};

const tryParse = (lines: string[]): MrzParseResult | undefined => {
  try {
    const result = parseMrzLines(lines);
    const f = result.fields;
    const fullName = [f.firstName, f.lastName].filter(Boolean).join(" ").trim() || null;
    return {
      valid: result.valid,
      fields: {
        documentNumber: f.documentNumber ?? null,
        fullName,
        dateOfBirth: f.birthDate ?? null,
        expiryDate: f.expirationDate ?? null,
        nationality: f.nationality ?? null,
        sex: f.sex ?? null,
      },
    };
  } catch {
    return undefined;
  }
};
