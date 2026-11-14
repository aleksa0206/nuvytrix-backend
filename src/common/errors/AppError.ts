import { ErrorCode } from './errorCodes';
import { ErrorMessages } from './errorMessages';

export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: FieldIssue[];

  constructor(code: ErrorCode, statusCode: number, customMessage?: string, details?: FieldIssue[]) {
    super(customMessage ?? ErrorMessages[code]);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(code: ErrorCode = ErrorCode.VALIDATION_ERROR, details?: FieldIssue[]) {
    super(code, 400, undefined, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(code: ErrorCode = ErrorCode.UNAUTHORIZED) {
    super(code, 401);
  }
}

export class LockedError extends AppError {
  constructor() {
    super(ErrorCode.ACCOUNT_LOCKED, 423);
  }
}

export class NotFoundError extends AppError {
  constructor(code: ErrorCode = ErrorCode.NOT_FOUND) {
    super(code, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: ErrorCode = ErrorCode.CONFLICT) {
    super(code, 409);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: ErrorCode) {
    super(code, 503);
  }
}
