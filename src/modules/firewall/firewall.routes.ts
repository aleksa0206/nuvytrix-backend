import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { firewallLogUpload } from '../../common/middleware/upload';
import { validateBody, validateParams, validateQuery } from '../../common/middleware/validate';
import {
  changePolicyStatus,
  createPolicy,
  deletePolicy,
  getEvent,
  getFacets,
  getImport,
  getInsights,
  getPolicy,
  getSummary,
  importLog,
  listEvents,
  listImports,
  listPolicies,
  policyInstructions,
  updatePolicy,
} from './firewall.controller';
import {
  eventListQuerySchema,
  idParamSchema,
  importListQuerySchema,
  rangeQuerySchema,
} from './firewall.schema';
import {
  changeStatusSchema,
  confirmSchema,
  createPolicySchema,
  updatePolicySchema,
} from './policies.schema';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /firewall/imports:
 *   post:
 *     summary: Upload a Huawei firewall log file exported from the router
 *     description: >
 *       Parses every line, stores valid events, skips events already imported and records
 *       rejected lines with their reason. Plain text, .log or .txt.
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       201: { description: Import summary with processed, inserted, duplicate and rejected counts }
 *       400: { description: Missing or unsupported file }
 *       413: { description: File too large }
 *   get:
 *     summary: Import history
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Paginated imports }
 */
router.post('/imports', firewallLogUpload, importLog);
router.get('/imports', validateQuery(importListQuerySchema), listImports);

/**
 * @swagger
 * /firewall/imports/{id}:
 *   get:
 *     summary: One import with its rejected lines
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Import }
 */
router.get('/imports/:id', validateParams(idParamSchema), getImport);

/**
 * @swagger
 * /firewall/events:
 *   get:
 *     summary: Firewall events with filtering, sorting and pagination
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: action, schema: { type: string, enum: [accept, deny] } }
 *       - { in: query, name: direction, schema: { type: string, enum: [internet_to_lan, internet_to_router, lan_to_internet, lan_to_router] } }
 *       - { in: query, name: flow, schema: { type: string, enum: [inbound, outbound] } }
 *       - { in: query, name: protocol, schema: { type: string } }
 *       - { in: query, name: ipVersion, schema: { type: integer, enum: [4, 6] } }
 *       - { in: query, name: ip, schema: { type: string }, description: Matches source or destination }
 *       - { in: query, name: port, schema: { type: integer }, description: Matches source or destination port }
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *       - { in: query, name: sort, schema: { type: string, enum: [occurred_at, source_ip, destination_ip, destination_port] } }
 *       - { in: query, name: order, schema: { type: string, enum: [asc, desc] } }
 *     responses:
 *       200: { description: Paginated events }
 */
router.get('/events', validateQuery(eventListQuerySchema), listEvents);

/**
 * @swagger
 * /firewall/events/facets:
 *   get:
 *     summary: Filter values that actually occur in the imported data
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Distinct actions, directions, protocols and IP versions }
 */
router.get('/events/facets', getFacets);

/**
 * @swagger
 * /firewall/events/{id}:
 *   get:
 *     summary: One event including its original log line
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Event }
 */
router.get('/events/:id', validateParams(idParamSchema), getEvent);

/**
 * @swagger
 * /firewall/summary:
 *   get:
 *     summary: Counts and hourly timeline; defaults to the last 7 days of imported data
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Summary }
 * /firewall/insights:
 *   get:
 *     summary: Observed patterns (repeated denials, accepted inbound traffic, denied ports)
 *     description: Observations only; they are not security verdicts.
 *     tags: [Firewall]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Insights }
 */
router.get('/summary', validateQuery(rangeQuerySchema), getSummary);
router.get('/insights', validateQuery(rangeQuerySchema), getInsights);

/**
 * @swagger
 * /firewall/policies:
 *   get:
 *     summary: Intended firewall rules tracked in Nuvytrix
 *     description: >
 *       The router has no supported management API, so these rules are never synchronised
 *       automatically. Status shows whether a rule is a draft, waiting for manual application,
 *       marked as applied by the administrator, or failed.
 *     tags: [Firewall policies]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Policies }
 *   post:
 *     summary: Create a draft policy
 *     tags: [Firewall policies]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       201: { description: Created }
 */
router.get('/policies', listPolicies);
router.post('/policies', validateBody(createPolicySchema), createPolicy);

/**
 * @swagger
 * /firewall/policies/{id}:
 *   get:
 *     summary: One policy
 *     tags: [Firewall policies]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Policy }
 *   patch:
 *     summary: Edit a policy; a rule marked as applied returns to "pending manual"
 *     tags: [Firewall policies]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Policy }
 *   delete:
 *     summary: Delete a policy (requires {"confirm":true})
 *     tags: [Firewall policies]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       428: { description: Confirmation required }
 */
router.get('/policies/:id', validateParams(idParamSchema), getPolicy);
router.patch(
  '/policies/:id',
  validateParams(idParamSchema),
  validateBody(updatePolicySchema),
  updatePolicy
);
router.delete(
  '/policies/:id',
  validateParams(idParamSchema),
  validateBody(confirmSchema),
  deletePolicy
);

/**
 * @swagger
 * /firewall/policies/{id}/status:
 *   post:
 *     summary: Move a policy to another status; marking as applied or retired requires {"confirm":true}
 *     tags: [Firewall policies]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Policy }
 *       409: { description: Transition not allowed }
 *       428: { description: Confirmation required }
 * /firewall/policies/{id}/instructions:
 *   get:
 *     summary: Steps for applying the policy by hand in the router web interface
 *     tags: [Firewall policies]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Instructions and warnings }
 */
router.post(
  '/policies/:id/status',
  validateParams(idParamSchema),
  validateBody(changeStatusSchema),
  changePolicyStatus
);
router.get('/policies/:id/instructions', validateParams(idParamSchema), policyInstructions);

export default router;
