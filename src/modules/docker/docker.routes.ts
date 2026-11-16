import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { container } from '../../container';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /docker/containers:
 *   get:
 *     summary: Containers on the server with state, health, restarts, uptime, CPU and memory
 *     description: >
 *       Read through a proxy that allows only listing and inspecting containers (no exec, start,
 *       stop, logs or file access). Refreshed every minute.
 *     tags: [Server]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: "{ enabled, checkedAt, error, containers }" }
 */
router.get(
  '/containers',
  asyncHandler(async (_req, res) => {
    res.json(container.dockerMonitorService.status);
  })
);

export default router;
