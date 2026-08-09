import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { DirectoryError } from '../services/directory.js';

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
  // A directory refusal usually has more to say than one sentence — every
  // problem with a form, or the names of the people still reporting to a
  // leaver. Carried through as `problems` so a screen can list them.
  if (err instanceof DirectoryError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.problems.length > 0 ? { problems: err.problems } : {}),
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong handling that request.' });
}
