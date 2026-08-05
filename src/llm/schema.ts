import { z, type ZodType } from "zod";

/**
 * JSON Schema object as consumed by structured-output LLMs and by the
 * `GET /v1/ocr/functions` catalog. Kept loose on purpose — the source of truth
 * is always the Zod schema it was derived from.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Derives a JSON Schema from a Zod schema so the validator and the structured-output
 * contract can't drift. Uses Zod 4's native converter,
 * targeting draft 2020-12 with closed objects (`additionalProperties: false`),
 * which is what OpenAI-compatible structured outputs require.
 *
 * @param schema - The Zod schema to convert.
 * @param name - Optional schema name (used as the structured-output schema name).
 */
export const toJsonSchema = (schema: ZodType, name?: string): JsonSchema => {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" }) as JsonSchema;
  if (name) json.title = name;
  return json;
};
