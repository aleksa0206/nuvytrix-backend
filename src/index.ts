import { env } from './config/env';
import app from './app';
import { db } from './config/db';
import { logger } from './config/logger';
import { container } from './container';
import { runMigrations } from './database/migrate';

const HOURLY_MS = 60 * 60 * 1000;

function startBackgroundJobs() {
  setInterval(() => {
    container.authService
      .deleteExpiredSessions()
      .catch((err) => logger.error({ err }, 'Session cleanup failed'));
  }, HOURLY_MS).unref();

  setInterval(() => {
    container.monitoringService
      .runChecks()
      .catch((err) => logger.error({ err }, 'Monitoring round failed'));
  }, env.MONITORING_INTERVAL_SECONDS * 1000).unref();

  setInterval(() => void container.deviceIntelService.deleteExpired(), HOURLY_MS).unref();

  setInterval(() => {
    container.alertsService
      .deleteExpired()
      .catch((err) => logger.error({ err }, 'Alert cleanup failed'));
  }, HOURLY_MS).unref();

  setInterval(() => {
    container.monitoringService
      .deleteExpiredResults()
      .catch((err) => logger.error({ err }, 'Monitoring retention cleanup failed'));
  }, HOURLY_MS).unref();

  if (container.routerService.isConfigured) {
    const pollRouter = () =>
      container.routerService.poll().catch((err) => logger.error({ err }, 'Router poll failed'));
    void pollRouter();
    setInterval(pollRouter, env.ROUTER_POLL_SECONDS * 1000).unref();
    setInterval(() => {
      container.routerService
        .deleteExpiredSamples()
        .catch((err) => logger.error({ err }, 'Router sample cleanup failed'));
    }, HOURLY_MS).unref();
    if (env.ROUTER_FIREWALL_LOG_POLL_MINUTES > 0) {
      setInterval(
        () => {
          container.routerService
            .importFirewallLog()
            .catch((err) => logger.warn({ err: err.message }, 'Router firewall log import failed'));
        },
        env.ROUTER_FIREWALL_LOG_POLL_MINUTES * 60 * 1000
      ).unref();
    }
  }

  if (env.DISCOVERY_INTERVAL_MINUTES > 0) {
    setInterval(
      () => {
        container.devicesService.startScan(undefined, null).catch((err) => {
          logger.warn({ err: err.message }, 'Scheduled discovery scan skipped');
        });
      },
      env.DISCOVERY_INTERVAL_MINUTES * 60 * 1000
    ).unref();
  }
}

async function main() {
  await runMigrations();
  await container.monitoringService.syncManagedTargets();
  const interrupted = await container.devicesService.failInterruptedScans();
  if (interrupted > 0) logger.warn({ interrupted }, 'Marked interrupted discovery scans as failed');

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(`Nuvytrix API listening on http://${env.HOST}:${env.PORT}`);
  });
  startBackgroundJobs();

  async function shutdown(signal: string) {
    logger.info(`${signal} received, shutting down`);
    setTimeout(() => {
      logger.error('Forced shutdown: timeout exceeded');
      process.exit(1);
    }, 10_000).unref();
    server.close(async () => {
      await db.destroy();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// The process is in an unknown state after these: log why, exit, and let Docker restart it.
function crash(kind: string, err: unknown) {
  logger.fatal({ err }, kind);
  process.exit(1);
}
process.on('unhandledRejection', (err) => crash('Unhandled promise rejection', err));
process.on('uncaughtException', (err) => crash('Uncaught exception', err));

main().catch((err) => crash('Startup failed', err));
