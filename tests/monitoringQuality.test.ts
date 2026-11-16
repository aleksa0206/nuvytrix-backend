import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import { parsePingOutput, type ProbeResult } from '../src/modules/monitoring/probes';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const UP: ProbeResult = { success: true, latencyMs: 12, packetLossPercent: 0, error: null };

class FakeProber {
  http = async (url: string): Promise<ProbeResult> =>
    this.httpReplies.get(url) ?? { ...UP, httpStatus: 200 };
  httpReplies = new Map<string, ProbeResult>();
  async ping() {
    return { ...UP, jitterMs: 0.5 };
  }
  async resolve() {
    return UP;
  }
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('monitoring quality', () => {
  let prober: FakeProber;

  beforeEach(async () => {
    await prepareDatabase();
    prober = new FakeProber();
    resetContainer({ prober });
  });

  it('reads jitter from ping output', () => {
    const out =
      '3 packets transmitted, 3 received, 0% packet loss\nrtt min/avg/max/mdev = 4.1/4.9/5.8/0.71 ms';
    expect(parsePingOutput(out)).toMatchObject({ latencyMs: 4.9, jitterMs: 0.71 });
  });

  it('accepts only http(s) URLs for HTTP targets and checks them with status and certificate', async () => {
    const agent = await signedInAgent();
    for (const host of ['example.com', 'ftp://example.com', 'https://user:pw@example.com']) {
      const res = await agent
        .post('/api/monitoring/targets')
        .send({ name: 'x', kind: 'http', host });
      expect(res.status).toBe(400);
    }
    const ping = await agent
      .post('/api/monitoring/targets')
      .send({ name: 'x', kind: 'icmp', host: 'https://example.com' });
    expect(ping.status).toBe(400);

    const expires = new Date(Date.now() + 60 * 86_400_000);
    prober.httpReplies.set('https://site.test/', {
      ...UP,
      httpStatus: 200,
      certExpiresAt: expires,
    });
    const { body: target } = await agent
      .post('/api/monitoring/targets')
      .send({ name: 'Site', kind: 'http', host: 'https://site.test/' });
    await container.monitoringService.runChecks();

    const [listed] = (await agent.get('/api/monitoring/targets')).body;
    expect(listed).toMatchObject({ id: target.id, status: 'up' });
    expect(listed.lastCheck).toMatchObject({
      httpStatus: 200,
      certExpiresAt: expires.toISOString(),
    });
  });

  it('warns once about a certificate that expires soon', async () => {
    const agent = await signedInAgent();
    prober.httpReplies.set('https://site.test/', {
      ...UP,
      httpStatus: 200,
      certExpiresAt: new Date(Date.now() + 5 * 86_400_000),
    });
    await agent
      .post('/api/monitoring/targets')
      .send({ name: 'Site', kind: 'http', host: 'https://site.test/' });
    await container.monitoringService.runChecks();
    await container.monitoringService.runChecks();

    const titles = (await container.alertsService.list()).alerts.map((a) => a.title);
    expect(titles.filter((t) => t.includes('certificate'))).toEqual([
      'Site: certificate expires in 4 days',
    ]);
  });

  it('lists outages of two or more failed checks, the ongoing one without an end', async () => {
    const agent = await signedInAgent();
    const { body: target } = await agent
      .post('/api/monitoring/targets')
      .send({ name: 'Server', kind: 'icmp', host: '192.168.100.10' });
    const base = Date.now() - 30 * 60_000;
    const pattern = [true, false, true, false, false, false, true, false, false];
    await db('monitoring_results').insert(
      pattern.map((success, i) => ({
        target_id: target.id,
        success,
        checked_at: new Date(base + i * 60_000),
        error: success ? null : 'No reply',
      }))
    );

    const { body } = await agent.get(`/api/monitoring/targets/${target.id}/outages?days=1`);

    expect(
      body.outages.map((o: { checks: number; end: string | null }) => [o.checks, o.end !== null])
    ).toEqual([
      [2, false],
      [3, true],
    ]);
    expect(body.outages[1].durationSeconds).toBe(180);
  });

  it('averages jitter into the series', async () => {
    const agent = await signedInAgent();
    const { body: target } = await agent
      .post('/api/monitoring/targets')
      .send({ name: 'Server', kind: 'icmp', host: '192.168.100.10' });
    await container.monitoringService.runChecks();
    const series = await agent.get(`/api/monitoring/targets/${target.id}/series?hours=1`);
    expect(series.body.points[0].avgJitterMs).toBe(0.5);
  });
});
