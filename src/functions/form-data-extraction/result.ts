import { z, type ZodType } from "zod";

import type { FieldSpec, FormDataExtractionArgs } from "./args";

/**
 * The result shape isn't known until request time, so it's built from the args.
 * The same schema is fed to Azure OpenAI's structured output
 * and used to validate the response.
 */
export type FormDataExtractionResult = { fields: Record<string, unknown> };

/** Maps a single FieldSpec to its Zod type, honoring `enum` and `required`. */
const fieldToZod = (spec: FieldSpec): ZodType => {
  let base: ZodType;
  if (spec.enum && spec.enum.length > 0) base = z.enum(spec.enum as [string, ...string[]]);
  else if (spec.type === "number") base = z.number();
  else if (spec.type === "boolean") base = z.boolean();
  else base = z.string(); // "string" and "date" (ISO string)
  return spec.required ? base : base.nullable();
};

/**
 * Compiles the caller's spec to a runtime validator. For `jsonSchema` args, use
 * `ajv` at execution time; the returned Zod schema here is a permissive
 * passthrough so the pipeline's generic validation step stays uniform.
 */
export const buildFormResultSchema = (args: FormDataExtractionArgs): ZodType<FormDataExtractionResult> => {
  if ("fields" in args) {
    const shape = Object.fromEntries(args.fields.map((f) => [f.name, fieldToZod(f)]));
    return z.object({ fields: z.object(shape) }) as unknown as ZodType<FormDataExtractionResult>;
  }
  return z.object({ fields: z.record(z.string(), z.unknown()) }) as ZodType<FormDataExtractionResult>;
};
