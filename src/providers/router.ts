import { policyForFunction, type ProviderPolicy } from "../config/providers";
import type { Capability, MimeGroup, OcrProvider } from "./types";
import type { OcrFunctionKey } from "../functions/define";

/**
 * Provider routing. Functions declare what they need;
 * providers declare what they have; the router matches. This is what prevents
 * silent wrong answers — a function needing `layout` can never be served by a
 * provider without bounding boxes.
 */
export type RoutingDecision = {
  provider: OcrProvider;
  fallbacks: OcrProvider[];
};

export type RouteInput = {
  group: MimeGroup;
  required: readonly Capability[];
  fn: OcrFunctionKey;
  policy: ProviderPolicy;
};

/** True if `provider` accepts the group and covers every required capability. */
export const providerSatisfies = (provider: OcrProvider, group: MimeGroup, required: readonly Capability[]): boolean =>
  provider.accepts.includes(group) && required.every((cap) => provider.capabilities.includes(cap));

/**
 * Selects a primary provider plus an ordered fallback chain.
 *
 * Rules: DOCX → mammoth always; PDF `text`-only → pdf-text first
 * then the scanned-PDF chain; PDF needing layout/seals/tables → skip pdf-parse,
 * use the scanned-PDF chain; image → the image chain. Providers that don't
 * satisfy the required capabilities are filtered out entirely.
 *
 * @throws Error when no registered provider can satisfy the request.
 */
export const routeProvider = (registry: readonly OcrProvider[], input: RouteInput): RoutingDecision => {
  const policy = policyForFunction(input.policy, input.fn);
  const order = preferenceOrder(input, policy);

  // Resolve names → satisfying instances, preserving preference order, then
  // append any other satisfying provider as a last-resort fallback.
  const byName = new Map(registry.map((p) => [p.name, p]));
  const satisfies = (p: OcrProvider | undefined): p is OcrProvider =>
    !!p && providerSatisfies(p, input.group, input.required);

  const ordered: OcrProvider[] = [];
  const seen = new Set<string>();
  const push = (p: OcrProvider | undefined) => {
    if (satisfies(p) && !seen.has(p.name)) {
      ordered.push(p);
      seen.add(p.name);
    }
  };

  order.forEach((name) => push(byName.get(name)));
  registry.forEach(push);

  const [provider, ...fallbacks] = ordered;
  if (!provider) {
    throw new Error(`No provider satisfies ${input.group} with capabilities [${input.required.join(", ")}]`);
  }
  return { provider, fallbacks };
};

/** The preferred provider-name order for a given input, before capability filtering. */
const preferenceOrder = (input: RouteInput, policy: ProviderPolicy): string[] => {
  switch (input.group) {
    case "docx":
      return ["mammoth"];
    case "text":
      return ["plain-text"];
    case "image":
      return [policy.image.primary, ...policy.image.fallbacks];
    case "pdf": {
      const scanned = [policy.scannedPdf.primary, ...policy.scannedPdf.fallbacks];
      const textOnly = input.required.every((c) => c === "text");
      // Text-only PDFs try the cheap digital text layer first; the scanned-PDF
      // chain covers the pages the per-page heuristic flags as scanned.
      return textOnly ? ["pdf-text", ...scanned] : scanned;
    }
  }
};
