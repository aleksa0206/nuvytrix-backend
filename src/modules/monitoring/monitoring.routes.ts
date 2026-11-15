import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { validateBody, validateParams, validateQuery } from '../../common/middleware/validate';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { requestContext } from '../../common/utils/requestContext';
import { container } from '../../container';
import {
  createTargetSchema,
  idParamSchema,
  seriesQuerySchema,
  updateTargetSchema,
} from './monitoring.schema';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /monitoring/targets:
 *   get:
 *     summary: Monitored hosts with their latest check and 24-hour uptime
 *     description: Uptime is computed only from checks that were actually run.
 *     tags: [Monitoring]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Targets }
 *   post:
 *     summary: Add a ping (icmp) or DNS resolution (dns) target
 *     tags: [Monitoring]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, kind, host]
 *             properties:
 *               name: { type: string }
 *               kind: { type: string, enum: [icmp, dns] }
 *               host: { type: string, description: Host to ping, or resolver IP for dns }
 *               dnsQueryName: { type: string, example: example.com }
 *               enabled: { type: boolean }
 *     responses:
 *       201: { description: Created }
 */
router.get(
  '/targets',
  asyncHandler(async (_req, res) => {
    res.json(await container.monitoringService.listTargets());
  })
);
router.post(
  '/targets',
  validateBody(createTargetSchema),
  asyncHandler(async (req, res) => {
    const target = await container.monitoringService.createTarget(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(target);
  })
);

/**
 * @swagger
 * /monitoring/targets/{id}:
 *   patch:
 *     summary: Edit a target (targets managed by configuration cannot be edited)
 *     tags: [Monitoring]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated }
 *       409: { description: Managed by configuration }
 *   delete:
 *     summary: Delete a target and its history
 *     tags: [Monitoring]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 */
router.patch(
  '/targets/:id',
  validateParams(idParamSchema),
  validateBody(updateTargetSchema),
  asyncHandler(async (req, res) => {
    const target = await container.monitoringService.updateTarget(
      res.locals.params.id,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(target);
  })
);
router.delete(
  '/targets/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    await container.monitoringService.deleteTarget(
      res.locals.params.id,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(204).end();
  })
);

/**
 * @swagger
 * /monitoring/targets/{id}/check:
 *   post:
 *     summary: Run one check immediately and store the result
 *     tags: [Monitoring]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Check result }
 * /monitoring/targets/{id}/series:
 *   get:
 *     summary: Recorded measurements averaged into buckets; empty when nothing was recorded
 *     tags: [Monitoring]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: hours, schema: { type: integer, default: 24 } }
 *     responses:
 *       200: { description: Series }
 */
router.post(
  '/targets/:id/check',
  validateParams(idParamSchema),
  asyncHandler(async (_req, res) => {
    res.json(await container.monitoringService.checkNow(res.locals.params.id));
  })
);
router.get(
  '/targets/:id/series',
  validateParams(idParamSchema),
  validateQuery(seriesQuerySchema),
  asyncHandler(async (_req, res) => {
    res.json(
      await container.monitoringService.getSeries(res.locals.params.id, res.locals.query.hours)
    );
  })
);

export default router;
