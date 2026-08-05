import { z } from "zod";

const signatureBlockSchema = z.object({
  label: z.string(),
  page: z.number().int(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  signed: z.boolean(),
  signatoryName: z.string().optional(),
  signedDate: z.string().optional(),
  hasSeal: z.boolean(),
  cropUrl: z.string().optional(),
});

export const signingResultSchema = z.object({
  fullyExecuted: z.boolean(),
  blocks: z.array(signatureBlockSchema),
  unsignedBlocks: z.array(z.string()),
});

export type SigningResult = z.infer<typeof signingResultSchema>;
