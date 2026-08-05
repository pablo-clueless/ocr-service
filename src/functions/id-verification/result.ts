import { z } from "zod";

import { idDocumentTypeSchema } from "./args";

export const idVerificationResultSchema = z.object({
  documentType: idDocumentTypeSchema,
  fields: z.object({
    fullName: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
    documentNumber: z.string().nullable(),
    expiryDate: z.string().nullable(),
    nationality: z.string().nullable(),
    sex: z.string().nullable(),
  }),
  checks: z.object({
    expired: z.boolean().nullable(),
    expiryDate: z.string().nullable(),
    nameMatch: z.boolean().nullable(),
    dobMatch: z.boolean().nullable(),
    numberMatch: z.boolean().nullable(),
    /** Deterministic MRZ checksum validity (passports); null when no MRZ present. */
    mrzValid: z.boolean().nullable(),
  }),
  /** Scope honesty: this verifies document-content consistency, not identity. */
  assuranceLevel: z.literal("document-content-only"),
});

export type IdVerificationResult = z.infer<typeof idVerificationResultSchema>;
