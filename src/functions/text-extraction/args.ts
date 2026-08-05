import { z } from "zod";

export const textExtractionArgsSchema = z.object({
  format: z.enum(["markdown", "plain"]).default("markdown"),
  pageRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  includeBlocks: z.boolean().default(false),
});

export type TextExtractionArgs = z.infer<typeof textExtractionArgsSchema>;
