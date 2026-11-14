import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import { db } from '../src/config/db';
import { container } from '../src/container';
import { MAX_FAILED_ATTEMPTS } from '../src/modules/auth/auth.service';
import { closeDatabase, prepareDatabase, signedInAgent, TEST_ADMIN } from './helpers/testDb';

afterAll(closeDatabase);

describe('authentication', () => {
  beforeEach(prepareDatabase);

  it('sets an httpOnly, SameSite=Strict session cookie and stores only its hash', async () => {
    await container.authService.createOrResetAdmin(TEST_ADMIN.username, TEST_ADMIN.password);

    const res = await request(app).post('/api/auth/login').send(TEST_ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.admin).toEqual({ username: 'admin' });
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^nuvytrix_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);

    const token = cookie.split(';')[0]!.split('=')[1]!;
    const session = await db('sessions').first();
    expect(session.token_hash).not.toBe(token);
    expect(session.token_hash).toHaveLength(64);
  });

  it('rejects a wrong password and an unknown user with the same response', async () => {
    await container.authService.createOrResetAdmin(TEST_ADMIN.username, TEST_ADMIN.password);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong-password' });
    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'wrong-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    await container.authService.createOrResetAdmin(TEST_ADMIN.username, TEST_ADMIN.password);
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt++) {
      await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrong-password' });
    }

    const res = await request(app).post('/api/auth/login').send(TEST_ADMIN);

    expect(res.status).toBe(423);
  });

  it('protects endpoints and invalidates the session on the server at logout', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);

    const agent = await signedInAgent();
    expect((await agent.get('/api/auth/me')).body.admin.username).toBe('admin');

    expect((await agent.post('/api/auth/logout')).status).toBe(204);
    expect(await db('sessions').count('* as count').first()).toEqual({ count: 0 });
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a session that has been idle longer than the idle timeout', async () => {
    const agent = await signedInAgent();
    await db('sessions').update({ last_seen_at: db.raw(`now() - interval '1 day'`) });

    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a session past its absolute max age even when recently used', async () => {
    const agent = await signedInAgent();
    await db('sessions').update({ expires_at: db.raw(`now() - interval '1 second'`) });

    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('validates the login body', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((issue: { path: string }) => issue.path)).toContain('password');
  });

  it('writes login and logout to the audit log', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/auth/logout');

    const actions = (await db('audit_logs').orderBy('id')).map((row) => row.action);
    expect(actions).toEqual(['auth.login', 'auth.logout']);
  });
});

describe('health', () => {
  it('reports the database as connected without authentication', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'connected' });
  });
});
