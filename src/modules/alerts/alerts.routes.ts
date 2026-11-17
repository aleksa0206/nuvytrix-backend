import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { validateBody } from '../../common/middleware/validate';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { requestContext } from '../../common/utils/requestContext';
import { thresholdsSchema } from './alertSettings.service';
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

/**
 * @swagger
 * /alerts/thresholds:
 *   get:
 *     summary: Alert thresholds (disk, memory, temperature, fiber signal, ping quality, SSH failures, backup age)
 *     tags: [Alerts]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Thresholds }
 *   put:
 *     summary: Change some thresholds; values outside the allowed range are refused. Audited.
 *     tags: [Alerts]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Thresholds after the change }
 */
router.get(
  '/thresholds',
  asyncHandler(async (_req, res) => {
    res.json(await container.alertSettingsService.load());
  })
);
router.put(
  '/thresholds',
  validateBody(
    thresholdsSchema
      .partial()
      .refine((v) => Object.keys(v).length > 0, 'At least one threshold is required')
  ),
  asyncHandler(async (req, res) => {
    res.json(
      await container.alertSettingsService.update(req.body, req.admin!.adminId, requestContext(req))
    );
  })
);

export default router;
