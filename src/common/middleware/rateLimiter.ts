import rateLimit from 'express-rate-limit';
import { ErrorCode } from '../errors/errorCodes';
import { ErrorMessages } from '../errors/errorMessages';

// Integration tests sign in dozens of times from one address; the per-account lockout is tested instead.
const skip = () => process.env.NODE_ENV === 'test';

const tooManyRequests = {
  code: ErrorCode.TOO_MANY_REQUESTS,
  message: ErrorMessages[ErrorCode.TOO_MANY_REQUESTS],
};

// ponytail: in-memory counters, fine for one API instance; use a shared store if it ever scales out
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooManyRequests,
  skip,
});

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooManyRequests,
  skip,
});
