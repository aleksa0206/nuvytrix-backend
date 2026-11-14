import { db } from '../config/db';
import { logger } from '../config/logger';
import { migrationSource } from './migrations';

export async function runMigrations(): Promise<void> {
  const [batch, applied] = await db.migrate.latest({ migrationSource });
  logger.info({ batch, applied }, applied.length ? 'Migrations applied' : 'Database is up to date');
}

if (require.main === module) {
  runMigrations()
    .then(() => db.destroy())
    .catch(async (err) => {
      logger.fatal({ err }, 'Migration failed');
      await db.destroy();
      process.exit(1);
    });
}
