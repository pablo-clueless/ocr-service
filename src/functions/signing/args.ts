import { z } from "zod";

export const signingArgsSchema = z.object({
  /** When true, return only detected block geometry and skip the vision judgment (no LLM). */
  geometryOnly: z.boolean().default(false),
  /** Signature-block cue phrases to correlate against nearby image blocks. */
  signatureCues: z.array(z.string()).default(["Signature", "Signed by", "For and on behalf of", "Witness", "Director"]),
});

export type SigningArgs = z.infer<typeof signingArgsSchema>;
