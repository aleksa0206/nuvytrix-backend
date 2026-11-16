import { env } from './config/env';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { logger } from './config/logger';
import { swaggerSpec } from './config/swagger';
import { apiRateLimiter } from './common/middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './common/middleware/errorHandler';
import authRoutes from './modules/auth/auth.routes';
import auditRoutes from './modules/audit/audit.routes';
import alertsRoutes from './modules/alerts/alerts.routes';
import serverRoutes from './modules/server/server.routes';
import dockerRoutes from './modules/docker/docker.routes';
import securityRoutes from './modules/security/security.routes';
import healthRoutes from './modules/health/health.routes';
import devicesRoutes from './modules/devices/devices.routes';
import firewallRoutes from './modules/firewall/firewall.routes';
import monitoringRoutes from './modules/monitoring/monitoring.routes';
import dnsRoutes from './modules/dns/dns.routes';
import overviewRoutes from './modules/overview/overview.routes';
import routerRoutes from './modules/router/router.routes';
import type {} from './types/express';

const app = express();

app.set('trust proxy', env.TRUST_PROXY);
app.disable('x-powered-by');

app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(
  pinoHttp({
    logger,
    // Health checks every few seconds would drown out real traffic in the logs.
    autoLogging: { ignore: (req) => req.url === '/api/health' },
    redact: {
      paths: ['req.headers.cookie', 'res.headers["set-cookie"]', 'req.headers.authorization'],
      censor: '[Redacted]',
    },
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const api = express.Router();
api.use('/health', healthRoutes);
api.use(apiRateLimiter);
api.use('/auth', authRoutes);
api.use('/audit-logs', auditRoutes);
api.use('/alerts', alertsRoutes);
api.use('/server', serverRoutes);
api.use('/docker', dockerRoutes);
api.use('/security', securityRoutes);
api.use('/firewall', firewallRoutes);
api.use('/monitoring', monitoringRoutes);
api.use('/dns', dnsRoutes);
api.use('/router', routerRoutes);
api.use(overviewRoutes);
api.use(devicesRoutes);
api.use(notFoundHandler);

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api-docs.json', (_req, res) => {
  res.json(swaggerSpec);
});
app.use('/api', api);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
