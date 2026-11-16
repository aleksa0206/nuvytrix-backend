import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { z } from 'zod';
import { validateBody, validateQuery } from '../../common/middleware/validate';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { requestContext } from '../../common/utils/requestContext';
import { dnsRuleSchema } from './dns.service';
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

/**
 * @swagger
 * /dns/querylog:
 *   get:
 *     summary: Latest DNS queries from AdGuard Home, with the device name of each client
 *     tags: [DNS]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 500 } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: blocked, schema: { type: boolean } }
 *     responses:
 *       200: { description: Queries, newest first }
 * /dns/rules:
 *   get:
 *     summary: Allow and block rules for single domains (other custom rules listed read-only)
 *     tags: [DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: "{ rules, otherRules }" }
 *   post:
 *     summary: Add an allow or block rule for a domain ({ domain, action })
 *     tags: [DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Rules after the change }
 * /dns/rules/delete:
 *   post:
 *     summary: Remove an allow or block rule ({ domain, action })
 *     tags: [DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Rules after the change }
 */
router.get(
  '/querylog',
  validateQuery(
    z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      search: z.string().trim().max(100).optional(),
      blocked: z.enum(['true', 'false']).optional(),
    })
  ),
  asyncHandler(async (_req, res) => {
    const q = res.locals.query;
    res.json(
      await container.dnsService.queryLog({
        limit: q.limit,
        search: q.search || undefined,
        blockedOnly: q.blocked === 'true',
      })
    );
  })
);
router.get(
  '/rules',
  asyncHandler(async (_req, res) => {
    res.json(await container.dnsService.rules());
  })
);
router.post(
  '/rules',
  validateBody(dnsRuleSchema),
  asyncHandler(async (req, res) => {
    res.json(await container.dnsService.addRule(req.body, req.admin!.adminId, requestContext(req)));
  })
);
router.post(
  '/rules/delete',
  validateBody(dnsRuleSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await container.dnsService.removeRule(req.body, req.admin!.adminId, requestContext(req))
    );
  })
);

export default router;
