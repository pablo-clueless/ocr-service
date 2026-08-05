import multer from "multer";

import { env } from "../config/env";

/**
 * Multipart upload with memory storage and a hard size cap enforced before
 * buffering completes. Type validation is deliberately
 * NOT done here via `fileFilter` — trust nothing from the client; the buffer is
 * sniffed downstream (see `ingest/sniff`).
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

/** Field name callers must use for the uploaded document. */
export const FILE_FIELD = "file";
