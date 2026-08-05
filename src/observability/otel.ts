import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";

import { env } from "../config/env";
import { logger } from "./logger";

/** Tracer/service name; also used by {@link import("./tracing").withSpan}. */
export const SERVICE_NAME = "ocr-service";

let provider: NodeTracerProvider | undefined;

/**
 * Registers the global OpenTelemetry tracer provider. Call once at process
 * startup (API server and worker), before the first span is created.
 *
 * Export target, in order: an OTLP/HTTP collector when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set; otherwise the console in development; otherwise nothing (spans are still
 * created and can be sampled, just not shipped). Instrumentation is always real —
 * only the exporter is environment-dependent.
 */
export const initTracing = (): void => {
  if (provider) return;

  const processors: SpanProcessor[] = [];
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT })));
    logger.info("tracing: exporting via OTLP", { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT });
  } else if (env.NODE_ENV === "development") {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: env.VERSION,
    }),
    spanProcessors: processors,
  });
  provider.register();
};

/** Flushes and shuts the provider down — call on graceful shutdown so spans aren't lost. */
export const shutdownTracing = async (): Promise<void> => {
  await provider?.shutdown();
  provider = undefined;
};
