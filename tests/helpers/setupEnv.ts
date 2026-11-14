// Defaults for a local throwaway Postgres (see README, "Running tests"); CI sets its own values.
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5433',
  DB_USER: 'nuvytrix',
  DB_PASSWORD: 'devpassword',
  DB_NAME: 'nuvytrix_test',
  ALLOWED_SCAN_CIDRS: '192.168.100.0/24',
  ROUTER_HOST: '',
  ADGUARD_URL: '',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
process.env.NODE_ENV = 'test';
