import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward a rejected promise from an async handler to error-handling
 * middleware — the request just hangs. Wrapping a handler with `ah` catches any thrown/
 * rejected error and forwards it to `next(err)`, so the terminal error middleware in app.ts
 * can turn it into a clean 500 instead of a timeout.
 */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
