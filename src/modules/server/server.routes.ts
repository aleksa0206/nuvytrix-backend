import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../common/middleware/auth';
import { validateQuery } from '../../common/middleware/validate';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { container } from '../../container';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /server/status:
 *   get:
 *     summary: The server's CPU, memory, load, temperature, power, disks, network errors and database health
 *     description: Last minute's sample (read without privileges from /proc and /sys); taken now if none yet.
 *     tags: [Server]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Server sample with sampledAt }
 * /server/history:
 *   get:
 *     summary: Server samples over time
 *     tags: [Server]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: hours, schema: { type: integer, minimum: 1, maximum: 720 } }
 *     responses:
 *       200: { description: "{ hours, points }" }
 */
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const service = container.serverMonitorService;
    res.json(service.last ?? { ...(await service.sample()), sampledAt: new Date() });
  })
);
router.get(
  '/history',
  validateQuery(z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) })),
  asyncHandler(async (_req, res) => {
    res.json(await container.serverMonitorService.history(res.locals.query.hours));
  })
);

/**
 * @swagger
 * /server/backups:
 *   get:
 *     summary: Database backups on the data disk per project (newest file, size, age, readable)
 *     description: Read-only view of the files the server's backup scripts write. Checked hourly.
 *     tags: [Server]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: "{ enabled, checkedAt, error, projects }" }
 */
router.get(
  '/backups',
  asyncHandler(async (_req, res) => {
    const service = container.backupMonitorService;
    if (service.enabled && !service.status.checkedAt) await service.check();
    res.json(service.status);
  })
);

export default router;
