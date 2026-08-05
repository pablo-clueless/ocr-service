import { SpanStatusCode, trace } from "@opentelemetry/api";

import { SERVICE_NAME } from "./otel";

/**
 * Tracing seam. `pii` functions must disable response-body capture here
 * — the sensitivity middleware is responsible for calling
 * `withSpan` with `captureResult: false`.
 */
export type SpanOptions = {
  attributes?: Record<string, string | number | boolean>;
  captureResult?: boolean;
};

const tracer = trace.getTracer(SERVICE_NAME);

/**
 * Runs `fn` inside an OpenTelemetry span: sets the caller's attributes, records
 * OK/ERROR status (and the exception on throw), and ends the span so its duration
 * is recorded. Span export is governed by the registered provider ({@link import("./otel").initTracing});
 * with none registered this degrades to a no-op tracer without changing behavior.
 *
 * The result payload is never attached to the span — `captureResult` is recorded
 * as an attribute only, so a `pii` span can never leak the response body.
 */
export const withSpan = async <T>(name: string, fn: () => Promise<T>, opts?: SpanOptions): Promise<T> =>
  tracer.startActiveSpan(name, async (span) => {
    if (opts?.attributes) span.setAttributes(opts.attributes);
    span.setAttribute("heirs.capture_result", opts?.captureResult ?? true);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
