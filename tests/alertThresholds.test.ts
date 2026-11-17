import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import type { ProbeResult } from '../src/modules/monitoring/probes';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

class FakeProber {
  latency = 10;
  up = true;
  async ping(): Promise<ProbeResult> {
    return this.up
      ? { success: true, latencyMs: this.latency, packetLossPercent: 0, jitterMs: 1, error: null }
      : { success: false, latencyMs: null, packetLossPercent: 100, error: 'No reply' };
  }
  async resolve(): Promise<ProbeResult> {
    return { success: true, latencyMs: 1, packetLossPercent: null, error: null };
  }
  async http(): Promise<ProbeResult> {
    return { success: true, latencyMs: 1, packetLossPercent: null, error: null };
  }
}

let prober: FakeProber;
const titles = async () =>
  (await container.alertsService.list()).alerts.map((a) => a.title).reverse();

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('alert thresholds and resolution', () => {
  beforeEach(async () => {
    await prepareDatabase();
    prober = new FakeProber();
    resetContainer({ prober });
  });

  it('reads and changes thresholds within bounds, audited', async () => {
    const agent = await signedInAgent();
    expect((await agent.get('/api/alerts/thresholds')).body).toMatchObject({
      diskPercent: 90,
      latencyMs: 200,
    });
    const res = await agent.put('/api/alerts/thresholds').send({ latencyMs: 50 });
    expect(res.body.latencyMs).toBe(50);
    expect(container.alertSettingsService.current.latencyMs).toBe(50);
    expect((await agent.put('/api/alerts/thresholds').send({ diskPercent: 10 })).status).toBe(400);
    expect((await agent.put('/api/alerts/thresholds').send({})).status).toBe(400);
    expect(await db('audit_logs').where({ action: 'alerts.thresholds_changed' })).toHaveLength(1);
  });

  it('alerts on latency above the threshold for three checks and resolves when it drops', async () => {
    const agent = await signedInAgent();
    await agent.put('/api/alerts/thresholds').send({ latencyMs: 50 });
    await agent
      .post('/api/monitoring/targets')
      .send({ name: 'NAS', kind: 'icmp', host: '192.168.100.60' });
    prober.latency = 120;
    for (let i = 0; i < 4; i++) await container.monitoringService.runChecks();
    prober.latency = 10;
    for (let i = 0; i < 3; i++) await container.monitoringService.runChecks();

    expect(await titles()).toEqual(['NAS: latency 120 ms (limit 50 ms)']);
    const [alert] = (await container.alertsService.list()).alerts;
    expect(alert!.resolvedAt).not.toBeNull();
  });

  it('does not repeat an open outage after a restart, and still reports its end', async () => {
    const agent = await signedInAgent();
    await agent
      .post('/api/monitoring/targets')
      .send({ name: 'NAS', kind: 'icmp', host: '192.168.100.60' });
    prober.up = false;
    await container.monitoringService.runChecks();
    await container.monitoringService.runChecks();
    resetContainer({ prober }); // the API restarts during the outage
    await container.monitoringService.runChecks();
    await container.monitoringService.runChecks();
    prober.up = true;
    await container.monitoringService.runChecks();

    expect(await titles()).toEqual(['NAS is not answering', 'NAS is back']);
  });
});
