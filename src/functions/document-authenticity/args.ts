import { z } from "zod";

/** No inputs — the analysis is fully determined by the uploaded bytes. */
export const documentAuthenticityArgsSchema = z.object({}).strip();

export type DocumentAuthenticityArgs = z.infer<typeof documentAuthenticityArgsSchema>;
