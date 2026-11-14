import type { CookieOptions, Request, Response } from 'express';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { requestContext } from '../../common/utils/requestContext';
import { env } from '../../config/env';
import { container } from '../../container';
import { SESSION_COOKIE } from './auth.service';

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict',
  path: '/',
};

async function loginHandler(req: Request, res: Response) {
  const { username, password } = req.body;
  const result = await container.authService.login(username, password, requestContext(req));
  res.cookie(SESSION_COOKIE, result.token, { ...cookieOptions, expires: result.expiresAt });
  res.json({ admin: result.admin, expiresAt: result.expiresAt });
}

async function logoutHandler(req: Request, res: Response) {
  await container.authService.logout(req.admin!, requestContext(req));
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  res.status(204).end();
}

async function meHandler(req: Request, res: Response) {
  res.json({ admin: { username: req.admin!.username } });
}

export const login = asyncHandler(loginHandler);
export const logout = asyncHandler(logoutHandler);
export const me = asyncHandler(meHandler);
