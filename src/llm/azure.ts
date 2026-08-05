import { AzureOpenAI } from "openai";
import type { ZodType } from "zod";

import { toJsonSchema, type JsonSchema } from "./schema";
import { env } from "../config/env";

/**
 * The interpretation layer's client contract. One
 * JSON-schema-constrained structured-output call per function. Tests inject a
 * `MockLlmClient` implementing this same interface.
 */
export type StructuredCompletion<T> = {
  data: T;
  tokensUsed: number;
};

export type StructuredRequest<T> = {
  system: string;
  user: string;
  /**
   * Optional image data URIs (`data:image/png;base64,...`) attached to the user
   * turn for vision judgments (e.g. SIGNING crops). Ignored by text-only callers.
   */
  images?: string[];
  /** Zod schema of the expected result; also used to derive the JSON Schema sent to the model. */
  schema: ZodType<T>;
  /** Optional pre-computed JSON Schema (skips re-deriving from `schema`). */
  jsonSchema?: JsonSchema;
  schemaName?: string;
  maxTokens?: number;
  signal?: AbortSignal;
};

/** OpenAI user-turn content: plain text, or text plus attached image parts (vision). */
type UserContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

const buildUserContent = (text: string, images?: string[]): UserContent => {
  if (!images?.length) return text;
  return [{ type: "text", text }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))];
};

export interface LlmClient {
  /** Runs one structured-output completion and returns the parsed, schema-validated result. */
  complete<T>(req: StructuredRequest<T>): Promise<StructuredCompletion<T>>;
}

/** Strips characters OpenAI disallows in a structured-output schema name. */
const sanitizeSchemaName = (name: string | undefined): string =>
  (name ?? "result").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "result";

/**
 * Azure OpenAI-backed {@link LlmClient}. Wraps the deployment configured in env.
 *
 * One JSON-schema-constrained `chat.completions` call per request: the Zod result
 * schema is converted to JSON Schema and sent as `response_format.json_schema`, so
 * the model is forced to emit the exact result shape. The returned JSON is then
 * re-validated against the same Zod schema — the model contract and the runtime
 * validator can never drift because both derive from one source.
 *
 * The client is created lazily on first use so importing this module never
 * throws when Azure is disabled (e.g. the TEXT_EXTRACTION-only smoke path).
 */
export class AzureLlmClient implements LlmClient {
  private client: AzureOpenAI | undefined;
  private readonly deployment: string;

  constructor() {
    this.deployment = env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "";
  }

  private getClient(): AzureOpenAI {
    if (env.AZURE_OPENAI_ENABLED !== "true") {
      throw new Error("Azure OpenAI is disabled (set AZURE_OPENAI_ENABLED=true and configure the deployment).");
    }
    if (!this.client) {
      if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_API_KEY || !this.deployment) {
        throw new Error("Azure OpenAI is misconfigured: endpoint, api key, and deployment name are all required.");
      }
      this.client = new AzureOpenAI({
        endpoint: env.AZURE_OPENAI_ENDPOINT,
        apiKey: env.AZURE_OPENAI_API_KEY,
        apiVersion: env.AZURE_OPENAI_API_VERSION ?? "2024-10-21",
        deployment: this.deployment,
      });
    }
    return this.client;
  }

  async complete<T>(req: StructuredRequest<T>): Promise<StructuredCompletion<T>> {
    const client = this.getClient();
    const name = sanitizeSchemaName(req.schemaName);
    const schema = req.jsonSchema ?? toJsonSchema(req.schema, name);

    const response = await client.chat.completions.create(
      {
        model: this.deployment,
        max_completion_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: buildUserContent(req.user, req.images) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name, schema, strict: false },
        },
      },
      { signal: req.signal },
    );

    const message = response.choices[0]?.message;
    if (message?.refusal) {
      throw new Error(`Model refused the request: ${message.refusal}`);
    }
    const content = message?.content;
    if (!content) {
      throw new Error("Azure OpenAI returned an empty completion");
    }

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error("Azure OpenAI returned non-JSON content for a structured request");
    }

    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Azure OpenAI result failed schema validation: ${parsed.error.message}`);
    }

    return { data: parsed.data, tokensUsed: response.usage?.total_tokens ?? 0 };
  }
}

/** Deterministic client for tests — returns pre-seeded fixture responses. */
export class MockLlmClient implements LlmClient {
  constructor(private readonly responses: Map<string, unknown> = new Map()) {}

  async complete<T>(req: StructuredRequest<T>): Promise<StructuredCompletion<T>> {
    const key = req.schemaName ?? req.system;
    if (!this.responses.has(key)) {
      throw new Error(`MockLlmClient: no fixture registered for "${key}"`);
    }
    return { data: req.schema.parse(this.responses.get(key)), tokensUsed: 0 };
  }
}
