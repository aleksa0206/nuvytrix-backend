import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { container } from '../../container';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /dns/status:
 *   get:
 *     summary: Integration status of the DNS filtering provider (AdGuard Home)
 *     description: Returns configured=false when ADGUARD_URL is not set; no statistics are invented.
 *     tags: [DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Status }
 * /dns/stats:
 *   get:
 *     summary: Query and blocking statistics from AdGuard Home
 *     tags: [DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Statistics }
 *       503: { description: Not configured or unreachable }
 */
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await container.dnsService.getStatus());
  })
);
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    res.json(await container.dnsService.getStats());
  })
);

export default router;
