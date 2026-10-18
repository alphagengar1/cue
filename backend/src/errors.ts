import type { Response } from "express";
import type { ApiError, ErrorCode } from "../../shared/types.js";

export class CueError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400) {
    super(message);
  }
}

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  const body: ApiError = { error: { code, message } };
  res.status(status).json(body);
}
