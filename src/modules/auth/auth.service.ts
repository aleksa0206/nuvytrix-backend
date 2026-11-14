import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { LockedError, UnauthorizedError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { AuditService } from '../audit/audit.service';
import type { AuthRepository } from './auth.repository';
import type { AuthenticatedAdmin, RequestContext } from './auth.types';

export const SESSION_COOKIE = 'nuvytrix_session';
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
const BCRYPT_COST = 12;
// Writing last_seen_at on every request would turn each read into a write; a minute of
// imprecision is irrelevant against an idle timeout measured in tens of minutes.
const TOUCH_INTERVAL_SECONDS = 60;
// Compared against when the username does not exist, so both paths cost one bcrypt check.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', BCRYPT_COST);

export interface SessionSettings {
  idleMinutes: number;
  maxAgeHours: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export class AuthService {
  constructor(
    private authRepository: AuthRepository,
    private auditService: AuditService,
    private settings: SessionSettings
  ) {}

  async login(username: string, password: string, context: RequestContext) {
    const admin = await this.authRepository.findAdminByUsername(username);

    if (admin?.locked_until && admin.locked_until > new Date()) {
      await this.auditService.record({
        adminId: admin.id,
        action: 'auth.login_failed',
        details: { reason: 'locked' },
        ipAddress: context.ipAddress,
      });
      throw new LockedError();
    }

    const passwordMatches = await bcrypt.compare(password, admin?.password_hash ?? DUMMY_HASH);

    if (!admin || !passwordMatches) {
      if (admin) {
        await this.authRepository.recordFailedLogin(admin.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES);
      }
      await this.auditService.record({
        adminId: admin?.id ?? null,
        action: 'auth.login_failed',
        details: { username },
        ipAddress: context.ipAddress,
      });
      throw new UnauthorizedError(ErrorCode.INVALID_CREDENTIALS);
    }

    await this.authRepository.recordSuccessfulLogin(admin.id);

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.settings.maxAgeHours * 60 * 60 * 1000);
    await this.authRepository.createSession({
      adminId: admin.id,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    await this.auditService.record({
      adminId: admin.id,
      action: 'auth.login',
      ipAddress: context.ipAddress,
    });

    return { token, expiresAt, admin: { username: admin.username } };
  }

  /** Fail-closed: anything other than a live, unexpired, recently used session is rejected. */
  async authenticate(token: string | undefined): Promise<AuthenticatedAdmin> {
    if (!token) throw new UnauthorizedError();

    const session = await this.authRepository.findSessionWithAdmin(hashToken(token));
    if (!session) throw new UnauthorizedError();

    const now = Date.now();
    const idleLimit = session.last_seen_at.getTime() + this.settings.idleMinutes * 60 * 1000;
    if (session.expires_at.getTime() <= now || idleLimit <= now) {
      await this.authRepository.deleteSession(session.id);
      throw new UnauthorizedError();
    }

    await this.authRepository.touchSession(session.id, TOUCH_INTERVAL_SECONDS);

    return { adminId: session.admin_id, username: session.username, sessionId: session.id };
  }

  async logout(admin: AuthenticatedAdmin, context: RequestContext): Promise<void> {
    await this.authRepository.deleteSession(admin.sessionId);
    await this.auditService.record({
      adminId: admin.adminId,
      action: 'auth.logout',
      ipAddress: context.ipAddress,
    });
  }

  async createOrResetAdmin(username: string, password: string): Promise<void> {
    await this.authRepository.upsertAdmin(username, await hashPassword(password));
  }

  deleteExpiredSessions(): Promise<number> {
    return this.authRepository.deleteExpiredSessions(this.settings.idleMinutes);
  }
}
