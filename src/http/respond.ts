import type { Response } from "express";

import type { OcrResponseMeta } from "../pipeline";

/** Success envelope. */
export type OcrSuccessBody<TResult> = {
  requestId: string;
  function: string;
  result: TResult;
  meta: OcrResponseMeta;
};

export const sendSuccess = <TResult>(res: Response, status: number, body: OcrSuccessBody<TResult>): Response =>
  res.status(status).json(body);

/** Async-accepted envelope. */
export const sendAccepted = (res: Response, jobId: string): Response =>
  res.status(202).json({ jobId, statusUrl: `/v1/ocr/jobs/${jobId}` });
