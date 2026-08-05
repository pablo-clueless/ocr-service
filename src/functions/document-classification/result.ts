import { z } from "zod";

const alternativeSchema = z.object({
  label: z.string(),
  confidence: z.number().min(0).max(1),
});

export const documentClassificationResultSchema = z.object({
  label: z.string(),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(alternativeSchema),
  rationale: z.string(),
});

export type DocumentClassificationResult = z.infer<typeof documentClassificationResultSchema>;
