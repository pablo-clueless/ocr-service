import { z } from "zod";

const signalSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "low", "medium", "high"]),
  detail: z.string(),
});

/** Mirrors {@link import("../../authenticity/types").TamperSignals}. */
export const documentAuthenticityResultSchema = z.object({
  verdict: z.enum(["clean", "suspicious", "likely-doctored", "inconclusive"]),
  score: z.number().min(0).max(1),
  signals: z.array(signalSchema),
  assuranceLevel: z.literal("heuristic-only"),
  analyzer: z.enum(["pdf", "image", "unsupported"]),
  notes: z.array(z.string()).optional(),
});

export type DocumentAuthenticityResult = z.infer<typeof documentAuthenticityResultSchema>;
