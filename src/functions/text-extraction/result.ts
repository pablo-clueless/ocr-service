import { z } from "zod";

const blockSchema = z.object({
  index: z.number().int(),
  page: z.number().int(),
  label: z.enum(["image", "text", "formula", "table"]),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  content: z.string(),
});

export const textExtractionResultSchema = z.object({
  text: z.string(),
  format: z.enum(["markdown", "plain"]),
  pageCount: z.number().int(),
  blocks: z.array(blockSchema).optional(),
});

export type TextExtractionResult = z.infer<typeof textExtractionResultSchema>;
