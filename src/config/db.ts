import knex, { Knex } from 'knex';
import { types } from 'pg';
import { env } from './env';

// BIGINT counts (COUNT(*), bigserial ids) would otherwise arrive as strings.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const db: Knex = knex({
  client: 'pg',
  connection: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  },
  pool: { min: 0, max: 10 },
});
