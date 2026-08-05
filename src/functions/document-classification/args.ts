import { z } from "zod";

export const documentClassificationArgsSchema = z.object({
  candidateLabels: z.array(z.string()).optional(),
  allowUnknown: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.5),
  /** Cost control: classify from page 1 only unless the caller opts in. */
  fullDocument: z.boolean().default(false),
});

export type DocumentClassificationArgs = z.infer<typeof documentClassificationArgsSchema>;
