import Ajv from "ajv";

import { buildFormDataExtractionPrompt } from "./prompt";
import { buildFormResultSchema } from "./result";
import type { FormDataExtractionArgs } from "./args";
import type { FormDataExtractionResult } from "./result";
import type { JsonSchema } from "../../llm/schema";
import { OcrError } from "../../http/errors";
import type { OcrContext } from "../define";

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Extracts caller-defined fields. The result shape is per-request: it's compiled
 * from the caller's spec, fed to the LLM's structured output as the constraint,
 * and re-validated against the returned JSON. The `args` guard rails (field
 * count / nesting depth / byte ceiling) are already enforced by `argsSchema`.
 *
 * Two arg shapes:
 *  - `fields`: a structured spec → Zod object → JSON Schema (pipeline validates).
 *  - `jsonSchema`: a raw caller schema → sent to the model directly, then
 *    validated here with ajv (the Zod result schema is a permissive passthrough,
 *    so ajv is the real check for this branch).
 */
export const executeFormDataExtraction = async (
  ctx: OcrContext,
  args: FormDataExtractionArgs,
): Promise<FormDataExtractionResult> => {
  const { system, user } = buildFormDataExtractionPrompt(ctx.doc.markdown, args);
  const schema = buildFormResultSchema(args);

  if ("jsonSchema" in args) {
    const jsonSchema: JsonSchema = {
      type: "object",
      properties: { fields: args.jsonSchema },
      required: ["fields"],
      additionalProperties: false,
    };
    const { data } = await ctx.llm.complete({
      system,
      user,
      schema,
      jsonSchema,
      schemaName: "FORM_DATA_EXTRACTION_result",
    });
    assertMatchesJsonSchema(args.jsonSchema, data.fields);
    return data;
  }

  const { data } = await ctx.llm.complete({
    system,
    user,
    schema,
    schemaName: "FORM_DATA_EXTRACTION_result",
  });
  return data;
};

/** Validates the extracted `fields` object against the caller's raw JSON Schema. */
const assertMatchesJsonSchema = (jsonSchema: Record<string, unknown>, fields: unknown): void => {
  const validate = ajv.compile(jsonSchema);
  if (!validate(fields)) {
    throw new OcrError("SCHEMA_VALIDATION_FAILED", "Extracted fields did not match the provided JSON Schema", {
      retryable: false,
      details: validate.errors,
    });
  }
};
