import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { AppError } from '../errors/AppError';
import { ErrorCode } from '../errors/errorCodes';
import { ErrorMessages } from '../errors/errorMessages';
import { logger } from '../../config/logger';

function send(res: Response, status: number, code: ErrorCode, message = ErrorMessages[code]) {
  res.status(status).json({ code, message });
}

export function notFoundHandler(_req: Request, res: Response) {
  send(res, 404, ErrorCode.ROUTE_NOT_FOUND);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.statusCode === 401 || err.statusCode === 423) {
      logger.warn({ path: req.path, method: req.method, status: err.statusCode }, 'Access denied');
    }
    res
      .status(err.statusCode)
      .json({ code: err.code, message: err.message, ...(err.details && { details: err.details }) });
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return send(res, 413, ErrorCode.PAYLOAD_TOO_LARGE);
    return send(res, 400, ErrorCode.VALIDATION_ERROR, err.message);
  }

  const bodyParserType = (err as { type?: string } | null)?.type;
  if (bodyParserType === 'entity.parse.failed') return send(res, 400, ErrorCode.MALFORMED_JSON);
  if (bodyParserType === 'entity.too.large') return send(res, 413, ErrorCode.PAYLOAD_TOO_LARGE);

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  send(res, 500, ErrorCode.INTERNAL_ERROR);
}
