import type { Request, Response, NextFunction } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../errors/AppError';

function toIssues(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export function validateBody(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) throw new ValidationError(undefined, toIssues(result.error));
    req.body = result.data;
    next();
  };
}

// Express 5 makes req.query a getter, so parsed values live in res.locals instead.
export function validateQuery(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) throw new ValidationError(undefined, toIssues(result.error));
    res.locals.query = result.data;
    next();
  };
}

export function validateParams(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) throw new ValidationError(undefined, toIssues(result.error));
    res.locals.params = result.data;
    next();
  };
}
