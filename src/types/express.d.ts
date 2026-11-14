import type { AuthenticatedAdmin } from '../modules/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
    }
  }
}

export {};
