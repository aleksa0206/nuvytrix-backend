import { Router } from 'express';
import { z } from 'zod';
import { ConflictError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { requireAuth } from '../../common/middleware/auth';
import { validateQuery } from '../../common/middleware/validate';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { container } from '../../container';

const router = Router();
router.use(requireAuth);

const historyQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24),
});

/**
 * @swagger
 * /router/status:
 *   get:
 *     summary: Latest reading of the Huawei router (system, optics, WAN, ports, Wi-Fi, IPv4 filter)
 *     description: >
 *       Read through the router's web UI and UPnP on a schedule. Returns configured=false when
 *       ROUTER_USERNAME/ROUTER_PASSWORD are not set. Sections that could not be read are listed in errors.
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Status }
 * /router/clients:
 *   get:
 *     summary: Devices known to the router, with Wi-Fi signal data and the matching Nuvytrix device
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Clients }
 *       503: { description: Not configured or not polled yet }
 * /router/upnp:
 *   get:
 *     summary: Port mappings opened through UPnP
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Mappings }
 * /router/history:
 *   get:
 *     summary: Stored router samples (CPU, memory, optics, WAN rate, clients)
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: hours, schema: { type: integer, default: 24 } }
 *     responses:
 *       200: { description: Samples }
 * /router/refresh:
 *   post:
 *     summary: Poll the router now
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Fresh status }
 *       409: { description: A poll is already running }
 */
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(container.routerService.getStatus());
  })
);
router.get(
  '/clients',
  asyncHandler(async (_req, res) => {
    res.json(await container.routerService.getClients());
  })
);
router.get(
  '/upnp',
  asyncHandler(async (_req, res) => {
    res.json(await container.routerService.getPortMappings());
  })
);
router.get(
  '/history',
  validateQuery(historyQuerySchema),
  asyncHandler(async (_req, res) => {
    res.json(await container.routerService.getHistory(res.locals.query.hours));
  })
);
router.post(
  '/refresh',
  asyncHandler(async (_req, res) => {
    if (container.routerService.isPolling) throw new ConflictError(ErrorCode.ROUTER_POLL_RUNNING);
    await container.routerService.poll();
    res.json(container.routerService.getStatus());
  })
);

export default router;
