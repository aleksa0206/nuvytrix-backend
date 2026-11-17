import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { container } from '../../container';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /overview:
 *   get:
 *     summary: Health of router, devices, firewall, monitoring and DNS from recorded data
 *     description: Each area reports operational, warning, error, unknown or not_configured.
 *     tags: [Overview]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Overview }
 * /system/capabilities:
 *   get:
 *     summary: Which features work on the current hardware and which need more
 *     tags: [Overview]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Capabilities }
 * /system/settings:
 *   get:
 *     summary: Non-secret runtime configuration
 *     tags: [Overview]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Settings }
 */
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    res.json(await container.overviewService.getOverview());
  })
);
router.get(
  '/system/capabilities',
  asyncHandler(async (_req, res) => {
    res.json(container.overviewService.getCapabilities());
  })
);
router.get(
  '/system/settings',
  asyncHandler(async (_req, res) => {
    res.json(container.overviewService.getSettings());
  })
);

/**
 * @swagger
 * /integrations:
 *   get:
 *     summary: Health of every integration (router, discovery, port scans, monitoring, AdGuard, Docker, PostgreSQL, SSH log, backups, Tailscale)
 *     description: Last success, current state (ok, warning, error, off) and the latest error for each.
 *     tags: [Overview]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Integrations }
 */
router.get(
  '/integrations',
  asyncHandler(async (_req, res) => {
    res.json(await container.integrationsService.list());
  })
);

export default router;
