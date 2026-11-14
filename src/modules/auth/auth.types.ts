export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  failed_login_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
}

export interface SessionRow {
  id: number;
  admin_id: number;
  token_hash: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export interface AuthenticatedAdmin {
  adminId: number;
  username: string;
  sessionId: number;
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}
