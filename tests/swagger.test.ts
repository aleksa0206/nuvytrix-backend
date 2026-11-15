import { describe, expect, it } from 'vitest';
import { swaggerSpec } from '../src/config/swagger';

describe('OpenAPI document', () => {
  it('collects the documented routes of every module', () => {
    const paths = Object.keys((swaggerSpec as { paths: Record<string, unknown> }).paths);

    for (const expected of [
      '/auth/login',
      '/devices',
      '/discovery/scans',
      '/firewall/imports',
      '/firewall/policies',
      '/monitoring/targets',
      '/dns/status',
      '/overview',
    ]) {
      expect(paths).toContain(expected);
    }
  });
});
