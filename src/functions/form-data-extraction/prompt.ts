import type { FormDataExtractionArgs } from "./args";
import { buildSystem, wrapUntrusted } from "../../llm/prompt";

export type Prompt = { system: string; user: string };

export const buildFormDataExtractionPrompt = (markdown: string, args: FormDataExtractionArgs): Prompt => {
  const fieldInstruction =
    "fields" in args
      ? `Extract these fields: ${args.fields
          .map((f) => `${f.name} (${f.type}${f.required ? ", required" : ""})`)
          .join(", ")}.`
      : "Extract values conforming to the provided JSON Schema.";

  const system = buildSystem([
    "You are a form data extraction assistant.",
    fieldInstruction,
    "Return null for any field not present in the document. Use the value as written on the form.",
  ]);

  const user = `Extract form fields from this document:\n\n${wrapUntrusted("DOCUMENT", markdown)}`;
  return { system, user };
};
