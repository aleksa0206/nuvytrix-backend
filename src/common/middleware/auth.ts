import type { Request, Response, NextFunction } from 'express';
import { container } from '../../container';
import { SESSION_COOKIE } from '../../modules/auth/auth.service';

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  container.authService
    .authenticate(req.cookies?.[SESSION_COOKIE])
    .then((admin) => {
      req.admin = admin;
      next();
    })
    .catch(next);
}
