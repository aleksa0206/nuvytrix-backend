import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import { db } from '../src/config/db';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

const line = (time: string, fields: string) =>
  `2026-11-14 ${time} [Notice] IN=Internet_DHCP OUT=LocalNetwork ${fields}`;

const DENY_REPLY = (time: string, source = '203.0.113.7') =>
  line(
    time,
    `Direction=Public->Private Action=Deny SRC=${source} DST=192.168.100.20 PROTO=TCP SPT=443 DPT=55090`
  );
const DENY_V6 = line(
  '21:40:00',
  'Direction=Public->Private Action=Deny SRC=2001:db8::1 DST=2001:db8::20 PROTO=UDP SPT=53 DPT=40000'
);
const ACCEPT_OUT = line(
  '21:41:00',
  'Direction=Private->Public Action=Accept SRC=192.168.100.20 DST=198.51.100.10 PROTO=TCP SPT=50000 DPT=443'
);

function upload(agent: Agent, content: string, fileName = 'firewall.log') {
  return agent.post('/api/firewall/imports').attach('file', Buffer.from(content), fileName);
}

afterAll(closeDatabase);

describe('firewall log import', () => {
  beforeEach(prepareDatabase);

  it('stores valid events and reports processed, rejected and blank lines', async () => {
    const agent = await signedInAgent();

    const res = await upload(
      agent,
      ['Firewall Log', DENY_REPLY('21:31:28'), '', DENY_V6, ACCEPT_OUT, 'broken line'].join('\n')
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fileName: 'firewall.log',
      totalLines: 6,
      parsedEvents: 3,
      insertedEvents: 3,
      duplicateEvents: 0,
      rejectedLines: 2,
      blankLines: 1,
    });
    expect(res.body.rejectedSample.map((r: { lineNumber: number }) => r.lineNumber)).toEqual([
      1, 6,
    ]);

    const details = await agent.get(`/api/firewall/imports/${res.body.id}`);
    expect(details.body.rejectedLines).toBe(2);
    expect(details.body.rejected).toHaveLength(2);
    expect(details.body.rejected[1]).toMatchObject({ lineNumber: 6, rawLine: 'broken line' });
  });

  it('does not duplicate events when the same or an overlapping export is uploaded again', async () => {
    const agent = await signedInAgent();
    await upload(agent, [DENY_REPLY('21:31:28'), DENY_REPLY('21:31:28'), DENY_V6].join('\n'));

    const again = await upload(
      agent,
      [DENY_REPLY('21:31:28'), DENY_REPLY('21:31:28'), DENY_V6, ACCEPT_OUT].join('\n')
    );

    expect(again.body).toMatchObject({ parsedEvents: 4, insertedEvents: 1, duplicateEvents: 3 });
    // The two identical lines are two real events and both are kept.
    expect(await db('firewall_events').count('* as count').first()).toEqual({ count: 4 });
  });

  it('accepts an empty file and records it', async () => {
    const agent = await signedInAgent();

    const res = await upload(agent, '');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ totalLines: 0, parsedEvents: 0, insertedEvents: 0 });
  });

  it('rejects missing, binary and wrongly typed files', async () => {
    const agent = await signedInAgent();

    const missing = await agent.post('/api/firewall/imports');
    const binary = await upload(agent, '\u0000\u0001ELF');
    const exe = await upload(agent, DENY_V6, 'payload.exe');

    expect(missing.body.code).toBe('FIREWALL_FILE_REQUIRED');
    expect(binary.body.code).toBe('FIREWALL_FILE_INVALID');
    expect(exe.body.code).toBe('FIREWALL_FILE_INVALID');
    expect(await db('firewall_log_imports').count('* as count').first()).toEqual({ count: 0 });
  });

  it('requires authentication for uploads', async () => {
    const res = await request(app)
      .post('/api/firewall/imports')
      .attach('file', Buffer.from(DENY_V6), 'f.log');

    expect(res.status).toBe(401);
  });
});

describe('firewall events', () => {
  beforeEach(prepareDatabase);

  async function seed(agent: Agent) {
    await upload(agent, [DENY_REPLY('21:31:28'), DENY_V6, ACCEPT_OUT].join('\n'));
  }

  it('filters by action, flow, protocol, IP version, address and port', async () => {
    const agent = await signedInAgent();
    await seed(agent);
    const ids = async (query: Record<string, string>) =>
      (await agent.get('/api/firewall/events').query(query)).body.data.map(
        (event: { protocol: string; action: string }) => `${event.action}/${event.protocol}`
      );

    expect(await ids({ action: 'deny' })).toEqual(['deny/UDP', 'deny/TCP']);
    expect(await ids({ flow: 'outbound' })).toEqual(['accept/TCP']);
    expect(await ids({ protocol: 'udp' })).toEqual(['deny/UDP']);
    expect(await ids({ ipVersion: '6' })).toEqual(['deny/UDP']);
    expect(await ids({ ip: '203.0.113.7' })).toEqual(['deny/TCP']);
    expect(await ids({ port: '443' })).toEqual(['accept/TCP', 'deny/TCP']);
  });

  it('sorts, paginates and validates query parameters', async () => {
    const agent = await signedInAgent();
    await seed(agent);

    const page = await agent
      .get('/api/firewall/events')
      .query({ sort: 'occurred_at', order: 'asc', pageSize: 2, page: 2 });
    expect(page.body.meta).toEqual({ total: 3, page: 2, pageSize: 2, totalPages: 2 });
    expect(page.body.data[0].action).toBe('accept');

    for (const query of [
      { sort: 'raw_line' },
      { ip: 'not-an-ip' },
      { port: '70000' },
      { pageSize: '1000' },
    ]) {
      expect((await agent.get('/api/firewall/events').query(query)).status).toBe(400);
    }
  });

  it('returns event details with the original log line', async () => {
    const agent = await signedInAgent();
    await seed(agent);
    const [first] = (await agent.get('/api/firewall/events')).body.data;

    const res = await agent.get(`/api/firewall/events/${first.id}`);

    expect(res.body.rawLine).toContain('Action=Accept');
    expect((await agent.get('/api/firewall/events/99999')).status).toBe(404);
  });

  it('offers only the filter values present in the data', async () => {
    const agent = await signedInAgent();
    await upload(agent, DENY_REPLY('21:31:28'));

    const res = await agent.get('/api/firewall/events/facets');

    expect(res.body).toEqual({
      actions: ['deny'],
      directions: ['internet_to_lan'],
      protocols: ['TCP'],
      ipVersions: [4],
    });
  });

  it('reports no data instead of zeros before anything was imported', async () => {
    const agent = await signedInAgent();

    expect((await agent.get('/api/firewall/summary')).body).toEqual({
      hasData: false,
      totalEvents: 0,
    });
    expect((await agent.get('/api/firewall/insights')).body.hasData).toBe(false);
  });

  it('describes repeated denials from HTTPS source ports as likely late replies, not attacks', async () => {
    const agent = await signedInAgent();
    const lines = Array.from({ length: 25 }, (_, i) =>
      DENY_REPLY(`21:${String(10 + i).padStart(2, '0')}:00`)
    );
    await upload(agent, lines.join('\n'));

    const res = await agent.get('/api/firewall/insights');

    expect(res.body.disclaimer).toMatch(/none of these observations/);
    expect(res.body.repeatedDeniedSources).toHaveLength(1);
    expect(res.body.repeatedDeniedSources[0]).toMatchObject({
      sourceIp: '203.0.113.7',
      events: 25,
    });
    expect(res.body.repeatedDeniedSources[0].interpretation).toMatch(/late replies/);
  });
});

describe('firewall policies', () => {
  beforeEach(prepareDatabase);

  const policy = {
    name: 'Block Telnet from internet',
    action: 'deny',
    direction: 'internet_to_lan',
    protocol: 'tcp',
    source: 'any',
    destination: '192.168.100.0/24',
    destinationPorts: '23',
  };

  it('creates drafts that are never reported as confirmed by the router', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/firewall/policies').send(policy);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'draft', routerState: 'unverified' });
  });

  it('requires confirmation before marking a rule as applied and audits each change', async () => {
    const agent = await signedInAgent();
    const { body: created } = await agent.post('/api/firewall/policies').send(policy);
    const status = (body: object) =>
      agent.post(`/api/firewall/policies/${created.id}/status`).send(body);

    expect((await status({ status: 'marked_applied' })).status).toBe(409);
    expect((await status({ status: 'pending_manual' })).status).toBe(200);
    expect((await status({ status: 'marked_applied' })).status).toBe(428);
    const applied = await status({ status: 'marked_applied', confirm: true });

    expect(applied.body.status).toBe('marked_applied');
    const audited = await db('audit_logs').where({ action: 'firewall.policy_status_changed' });
    expect(audited).toHaveLength(2);
  });

  it('moves an applied rule back to pending when it is edited', async () => {
    const agent = await signedInAgent();
    const { body: created } = await agent.post('/api/firewall/policies').send(policy);
    await agent
      .post(`/api/firewall/policies/${created.id}/status`)
      .send({ status: 'pending_manual' });
    await agent
      .post(`/api/firewall/policies/${created.id}/status`)
      .send({ status: 'marked_applied', confirm: true });

    const edited = await agent
      .patch(`/api/firewall/policies/${created.id}`)
      .send({ destinationPorts: '2323' });

    expect(edited.body).toMatchObject({ status: 'pending_manual', destinationPorts: '2323' });
  });

  it('warns about rules that could lock the administrator out of the router', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/firewall/policies').send({
      ...policy,
      direction: 'lan_to_router',
      protocol: 'any',
      destination: 'any',
      destinationPorts: null,
    });
    const instructions = await agent.get(`/api/firewall/policies/${res.body.id}/instructions`);

    expect(res.body.warnings[0]).toMatch(/lock you out/);
    expect(instructions.body.warnings[0]).toMatch(/lock you out/);
    expect(instructions.body.steps.join('\n')).toContain('Action: Deny');
  });

  it('validates addresses and ports and requires confirmation to delete', async () => {
    const agent = await signedInAgent();

    expect(
      (await agent.post('/api/firewall/policies').send({ ...policy, source: 'evil.com' })).status
    ).toBe(400);
    expect(
      (await agent.post('/api/firewall/policies').send({ ...policy, destinationPorts: '9-1' }))
        .status
    ).toBe(400);
    expect(
      (await agent.post('/api/firewall/policies').send({ ...policy, protocol: 'icmp' })).status
    ).toBe(400);

    const { body: created } = await agent.post('/api/firewall/policies').send(policy);
    expect((await agent.delete(`/api/firewall/policies/${created.id}`).send({})).status).toBe(428);
    expect(
      (await agent.delete(`/api/firewall/policies/${created.id}`).send({ confirm: true })).status
    ).toBe(204);
  });
});
