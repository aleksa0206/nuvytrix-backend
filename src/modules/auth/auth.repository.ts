import type { Knex } from 'knex';
import type { AdminRow, SessionRow } from './auth.types';

export class AuthRepository {
  constructor(private db: Knex) {}

  findAdminByUsername(username: string): Promise<AdminRow | undefined> {
    return this.db<AdminRow>('admins').where({ username }).first();
  }

  async upsertAdmin(username: string, passwordHash: string): Promise<void> {
    await this.db('admins')
      .insert({ username, password_hash: passwordHash })
      .onConflict('username')
      .merge({ password_hash: passwordHash, updated_at: this.db.fn.now() });
  }

  async recordSuccessfulLogin(adminId: number) {
    await this.db('admins').where({ id: adminId }).update({ last_login_at: this.db.fn.now() });
  }

  async hasRecentLoginFrom(
    adminId: number,
    ipAddress: string | undefined,
    days: number
  ): Promise<boolean> {
    if (!ipAddress) return false;
    const row = await this.db('audit_logs')
      .where({ admin_id: adminId, action: 'auth.login', ip_address: ipAddress })
      .andWhere('created_at', '>=', this.db.raw('now() - make_interval(days => ?)', [days]))
      .first('id');
    return row !== undefined;
  }

  async createSession(session: {
    adminId: number;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.db('sessions').insert({
      admin_id: session.adminId,
      token_hash: session.tokenHash,
      expires_at: session.expiresAt,
      ip_address: session.ipAddress ?? null,
      user_agent: session.userAgent?.slice(0, 512) ?? null,
    });
  }

  findSessionWithAdmin(
    tokenHash: string
  ): Promise<(SessionRow & { username: string }) | undefined> {
    return this.db('sessions as s')
      .join('admins as a', 'a.id', 's.admin_id')
      .where('s.token_hash', tokenHash)
      .first('s.*', 'a.username');
  }

  async touchSession(sessionId: number, minimumAgeSeconds: number): Promise<void> {
    await this.db('sessions')
      .where({ id: sessionId })
      .andWhere(
        'last_seen_at',
        '<',
        this.db.raw(`now() - make_interval(secs => ?)`, [minimumAgeSeconds])
      )
      .update({ last_seen_at: this.db.fn.now() });
  }

  async deleteSession(sessionId: number): Promise<void> {
    await this.db('sessions').where({ id: sessionId }).delete();
  }

  async deleteExpiredSessions(idleMinutes: number): Promise<number> {
    return this.db('sessions')
      .where('expires_at', '<', this.db.fn.now())
      .orWhere('last_seen_at', '<', this.db.raw(`now() - make_interval(mins => ?)`, [idleMinutes]))
      .delete();
  }
}
