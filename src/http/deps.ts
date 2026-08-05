import { AzureLlmClient, type LlmClient } from "../llm/azure";
import { defaultProviderPolicy } from "../config/providers";
import { logger } from "../observability/logger";
import { providerRegistry } from "../providers";
import type { PipelineDeps } from "../pipeline";
import { RedisExtractionCache } from "../cache";

/**
 * Composition root for the request pipeline. Assembles the concrete
 * {@link PipelineDeps} once and reuses them across requests — the providers,
 * LLM client, and cache are all stateless/connection-pooled, so a single set is
 * shared process-wide. Tests build their own deps (Mock LLM, in-memory cache)
 * and never call this.
 */
let deps: PipelineDeps | undefined;

const buildLlmClient = (): LlmClient => new AzureLlmClient();

export const getPipelineDeps = (): PipelineDeps => {
  if (!deps) {
    deps = {
      llm: buildLlmClient(),
      logger,
      providers: providerRegistry,
      cache: new RedisExtractionCache(),
      policy: defaultProviderPolicy,
    };
  }
  return deps;
};
