import type { Request } from 'express';
import type { RequestContext } from '../../modules/auth/auth.types';

export function requestContext(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.get('user-agent') };
}
