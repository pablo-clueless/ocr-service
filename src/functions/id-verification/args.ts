import { z } from "zod";

export const idDocumentTypeSchema = z.enum(["NIN", "PASSPORT", "DRIVERS_LICENSE", "VOTERS_CARD", "AUTO"]);
export type IdDocumentType = z.infer<typeof idDocumentTypeSchema>;

export const idVerificationArgsSchema = z.object({
  documentType: idDocumentTypeSchema.default("AUTO"),
  expected: z
    .object({
      fullName: z.string().optional(),
      dateOfBirth: z.string().optional(),
      documentNumber: z.string().optional(),
    })
    .optional(),
});

export type IdVerificationArgs = z.infer<typeof idVerificationArgsSchema>;
