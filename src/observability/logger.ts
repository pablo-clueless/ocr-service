/**
 * Minimal structured logger interface. Swap the implementation for pino/winston
 * without touching call sites. Sensitivity-aware redaction is applied upstream
 *: `pii` functions must never pass raw document text here.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a child logger with `fields` merged into every entry. */
  child(fields: LogFields): Logger;
}

const write = (level: string, msg: string, base: LogFields, fields?: LogFields): void => {
  const entry = { level, msg, time: new Date().toISOString(), ...base, ...fields };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const createLogger = (base: LogFields = {}): Logger => ({
  debug: (msg, fields) => write("debug", msg, base, fields),
  info: (msg, fields) => write("info", msg, base, fields),
  warn: (msg, fields) => write("warn", msg, base, fields),
  error: (msg, fields) => write("error", msg, base, fields),
  child: (fields) => createLogger({ ...base, ...fields }),
});

export const logger: Logger = createLogger();

/**
 * Field keys that must never reach the log sink for `pii`/`restricted` requests
 * (docs/regression-and-security.md V2): raw document text, extracted content, and
 * identity fields. Matched case-insensitively.
 */
export const SENSITIVE_LOG_KEYS: ReadonlySet<string> = new Set(
  [
    "markdown",
    "plainText",
    "plaintext",
    "text",
    "content",
    "result",
    "fields",
    "field",
    "fullName",
    "dateOfBirth",
    "documentNumber",
    "mrz",
    "cropUrl",
    "signatoryName",
  ].map((k) => k.toLowerCase()),
);

const REDACTED = "[redacted]";

/** Recursively replaces sensitive values with `[redacted]` (bounded depth). */
const redactFields = (fields: LogFields | undefined, depth = 0): LogFields | undefined => {
  if (!fields || depth > 4) return fields;
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_LOG_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactFields(value as LogFields, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
};

/**
 * Wraps a logger so sensitive fields are stripped before they reach the sink.
 * Used by the pipeline for `pii`/`restricted` functions — enforcement lives at
 * the point the context logger is built, so it can't be bypassed per call site.
 */
export const createRedactingLogger = (inner: Logger): Logger => ({
  debug: (msg, fields) => inner.debug(msg, redactFields(fields)),
  info: (msg, fields) => inner.info(msg, redactFields(fields)),
  warn: (msg, fields) => inner.warn(msg, redactFields(fields)),
  error: (msg, fields) => inner.error(msg, redactFields(fields)),
  child: (fields) => createRedactingLogger(inner.child(redactFields(fields) ?? {})),
});
