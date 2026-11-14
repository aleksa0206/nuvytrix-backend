import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { validateQuery } from '../../common/middleware/validate';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { paginationSchema } from '../../common/utils/pagination';
import { container } from '../../container';

const router = Router();

/**
 * @swagger
 * /audit-logs:
 *   get:
 *     summary: Administrative actions, newest first
 *     tags: [Audit]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, minimum: 1, maximum: 200 } }
 *     responses:
 *       200: { description: Paginated audit entries }
 */
router.get(
  '/',
  requireAuth,
  validateQuery(paginationSchema),
  asyncHandler(async (_req, res) => {
    res.json(await container.auditService.list(res.locals.query));
  })
);

export default router;
