import { Router } from 'express';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { db } from '../../config/db';

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Liveness and database connectivity, used by the Docker health check
 *     tags: [Health]
 *     responses:
 *       200: { description: API and database are reachable }
 *       503: { description: Database is unreachable }
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ status: 'ok', database: 'connected' });
    } catch {
      res.status(503).json({ status: 'error', database: 'disconnected' });
    }
  })
);

export default router;
