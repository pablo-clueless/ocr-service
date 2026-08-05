import type { DocumentClassificationArgs } from "./args";
import { buildSystem, wrapUntrusted } from "../../llm/prompt";

export type Prompt = { system: string; user: string };

/**
 * Classification prompt. When `candidateLabels` are supplied the model must pick
 * from them (respecting `allowUnknown`); otherwise it proposes a label. Result
 * is constrained by the Zod-derived JSON Schema, so no format instructions here.
 */
export const buildDocumentClassificationPrompt = (markdown: string, args: DocumentClassificationArgs): Prompt => {
  const labelInstruction =
    args.candidateLabels && args.candidateLabels.length > 0
      ? `Choose the single best label from: ${args.candidateLabels.join(", ")}.${
          args.allowUnknown ? ' If none fit, use "unknown".' : " You must choose one of the provided labels."
        }`
      : "Propose the most specific document type label that fits.";

  const system = buildSystem([
    "You are a document classification assistant.",
    "Identify the document type, your confidence (0–1), plausible alternatives, and a brief rationale.",
    labelInstruction,
  ]);

  const user = `Classify this document:\n\n${wrapUntrusted("DOCUMENT", markdown)}`;
  return { system, user };
};
