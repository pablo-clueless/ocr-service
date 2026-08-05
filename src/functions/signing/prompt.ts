import { buildSystem, wrapUntrusted } from "../../llm/prompt";

export type Prompt = { system: string; user: string };

/**
 * Vision judgment over a cropped signature region. GLM-OCR labels
 * signatures and seals as `image` blocks, so the crop plus its nearby cue text
 * goes to the vision model to decide signed/unsigned and seal-present.
 *
 * @param cueContext - Nearby text (e.g. "For and on behalf of ... Director").
 */
export const buildSigningJudgmentPrompt = (cueContext: string): Prompt => {
  const system = buildSystem([
    "You are a signature-block analyst.",
    "Given a cropped region of an executed document and its surrounding label text,",
    "decide whether it contains a handwritten signature, whether a company seal/stamp is present,",
    "and read any signatory name and date. Report signed=false if the region is an empty signature line.",
  ]);

  const user = `${wrapUntrusted("SIGNATURE-BLOCK CONTEXT", cueContext)}\n\nJudge the attached crop.`;
  return { system, user };
};
