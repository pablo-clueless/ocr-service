/** Typed error codes. Callers switch on these; a raw provider error is never surfaced. */
export const OcrErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  PAGE_LIMIT_EXCEEDED: "PAGE_LIMIT_EXCEEDED",
  INVALID_ARGS: "INVALID_ARGS",
  NO_TEXT_DETECTED: "NO_TEXT_DETECTED",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  INTERPRETATION_FAILED: "INTERPRETATION_FAILED",
  SCHEMA_VALIDATION_FAILED: "SCHEMA_VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export type OcrErrorCode = (typeof OcrErrorCode)[keyof typeof OcrErrorCode];

/** HTTP status paired with each error code. */
const STATUS_BY_CODE: Record<OcrErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNSUPPORTED_MEDIA_TYPE: 415,
  FILE_TOO_LARGE: 413,
  PAGE_LIMIT_EXCEEDED: 422,
  INVALID_ARGS: 400,
  NO_TEXT_DETECTED: 422,
  EXTRACTION_FAILED: 502,
  PROVIDER_UNAVAILABLE: 503,
  INTERPRETATION_FAILED: 502,
  SCHEMA_VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
};

export type OcrErrorBody = {
  error: {
    code: OcrErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: unknown;
  };
};

/** The one error type thrown across the service. The error middleware renders it to {@link OcrErrorBody}. */
export class OcrError extends Error {
  readonly code: OcrErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: OcrErrorCode, message: string, opts?: { retryable?: boolean; details?: unknown }) {
    super(message);
    this.name = "OcrError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.details = opts?.details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toBody(requestId: string): OcrErrorBody {
    return {
      error: { code: this.code, message: this.message, requestId, retryable: this.retryable, details: this.details },
    };
  }
}
