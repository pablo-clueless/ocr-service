import { z } from "zod";

export const resumeParsingArgsSchema = z.object({
  /** Normalize dates to ISO 8601 in the output. */
  normalizeDates: z.boolean().default(true),
});

export type ResumeParsingArgs = z.infer<typeof resumeParsingArgsSchema>;
