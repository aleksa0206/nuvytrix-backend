import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { container } from '../../container';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /alerts:
 *   get:
 *     summary: Latest notifications (internet down/up, new devices, optical signal), newest first
 *     tags: [Alerts]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: "{ unread, alerts }" }
 * /alerts/read-all:
 *   post:
 *     summary: Mark every notification as read
 *     tags: [Alerts]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: "{ marked }" }
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await container.alertsService.list());
  })
);
router.post(
  '/read-all',
  asyncHandler(async (_req, res) => {
    res.json({ marked: await container.alertsService.markAllRead() });
  })
);

export default router;
