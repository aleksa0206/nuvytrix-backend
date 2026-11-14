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
// The minimum cost keeps the test suite fast; it is never used outside NODE_ENV=test.
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;
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
  /**
   * Keyed on (username, client IP) rather than the account alone, so another device on the LAN
   * cannot lock the administrator out by failing on purpose. Unknown usernames lock the same way
   * as real ones, so a 423 does not reveal which usernames exist.
   * ponytail: in-memory, resets on restart and assumes one API instance; per-IP rate limiting
   * still caps guesses across restarts.
   */
  private failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private authRepository: AuthRepository,
    private auditService: AuditService,
    private settings: SessionSettings
  ) {}

  async login(username: string, password: string, context: RequestContext) {
    const attemptKey = `${username.toLowerCase()}|${context.ipAddress ?? 'unknown'}`;
    const admin = await this.authRepository.findAdminByUsername(username);
    // Runs before the lock check so a locked attempt costs the same time as any other.
    const passwordMatches = await bcrypt.compare(password, admin?.password_hash ?? DUMMY_HASH);

    if (this.isLocked(attemptKey)) {
      await this.auditService.record({
        adminId: admin?.id ?? null,
        action: 'auth.login_failed',
        details: { username, reason: 'locked' },
        ipAddress: context.ipAddress,
      });
      throw new LockedError();
    }

    if (!admin || !passwordMatches) {
      this.recordFailure(attemptKey);
      await this.auditService.record({
        adminId: admin?.id ?? null,
        action: 'auth.login_failed',
        details: { username },
        ipAddress: context.ipAddress,
      });
      throw new UnauthorizedError(ErrorCode.INVALID_CREDENTIALS);
    }

    this.failedAttempts.delete(attemptKey);
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

  private isLocked(attemptKey: string): boolean {
    const state = this.failedAttempts.get(attemptKey);
    return state !== undefined && state.lockedUntil > Date.now();
  }

  private recordFailure(attemptKey: string): void {
    const now = Date.now();
    for (const [key, state] of this.failedAttempts) {
      if (state.lockedUntil !== 0 && state.lockedUntil <= now) this.failedAttempts.delete(key);
    }
    const count = (this.failedAttempts.get(attemptKey)?.count ?? 0) + 1;
    this.failedAttempts.set(attemptKey, {
      count,
      lockedUntil: count >= MAX_FAILED_ATTEMPTS ? now + LOCK_MINUTES * 60_000 : 0,
    });
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
