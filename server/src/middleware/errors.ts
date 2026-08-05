import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/** Express 4 swallows rejections from async handlers; this re-throws them properly. */
export function asyncRoute<T extends (req: Request, res: Response, next: NextFunction) => unknown>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found.' });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request.', details: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong handling that request.' });
}
