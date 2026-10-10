import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodTypeAny } from 'zod';

function validationHandler(schema: ZodTypeAny, source: 'body' | 'query'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    if (source === 'body') req.body = result.data;
    next();
  };
}

export const validateBody = (schema: ZodTypeAny): RequestHandler => validationHandler(schema, 'body');
export const validateQuery = (schema: ZodTypeAny): RequestHandler => validationHandler(schema, 'query');
