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
 * /security/ssh:
 *   get:
 *     summary: SSH logins to the server (accepted and failed), by source, and the latest events
 *     description: Read from the host's auth.log, mounted read-only. Nothing about SSH is changed.
 *     tags: [Security]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: hours, schema: { type: integer, minimum: 1, maximum: 720 } }
 *     responses:
 *       200: { description: "{ accepted, failed, sources, recent, lastRun, error }" }
 */
router.get(
  '/ssh',
  validateQuery(z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) })),
  asyncHandler(async (_req, res) => {
    res.json(await container.sshMonitorService.summary(res.locals.query.hours));
  })
);

export default router;
