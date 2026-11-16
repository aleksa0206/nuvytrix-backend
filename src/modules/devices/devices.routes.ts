import { Router } from 'express';
import { requireAuth } from '../../common/middleware/auth';
import { validateBody, validateParams, validateQuery } from '../../common/middleware/validate';
import {
  getDevice,
  getPresence,
  getScan,
  listDevices,
  listScans,
  startScan,
  updateDevice,
} from './devices.controller';
import {
  deviceListQuerySchema,
  idParamSchema,
  presenceQuerySchema,
  scanListQuerySchema,
  startScanSchema,
  updateDeviceSchema,
} from './devices.schema';

const router = Router();
router.use(requireAuth);

/**
 * @swagger
 * /devices:
 *   get:
 *     summary: Devices discovered on the local network
 *     tags: [Devices]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Name, hostname, vendor, IP or MAC }
 *       - { in: query, name: status, schema: { type: string, enum: [online, offline, new] } }
 *       - { in: query, name: sort, schema: { type: string, enum: [last_seen_at, first_seen_at, ip_address, name] } }
 *       - { in: query, name: order, schema: { type: string, enum: [asc, desc] } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: pageSize, schema: { type: integer } }
 *     responses:
 *       200: { description: Paginated devices }
 */
router.get('/devices', validateQuery(deviceListQuerySchema), listDevices);

/**
 * @swagger
 * /devices/{id}:
 *   get:
 *     summary: One device with its recent observations
 *     tags: [Devices]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Device }
 *       404: { description: Not found }
 *   patch:
 *     summary: Set a custom name, type or notes
 *     tags: [Devices]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               customName: { type: string, nullable: true }
 *               deviceType: { type: string, nullable: true }
 *               notes: { type: string, nullable: true }
 *     responses:
 *       200: { description: Updated device }
 */
router.get('/devices/:id', validateParams(idParamSchema), getDevice);

/**
 * @swagger
 * /devices/{id}/presence:
 *   get:
 *     summary: Share of router reads that saw the device online, per hour (router read every few minutes)
 *     tags: [Devices]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: days, schema: { type: integer, minimum: 1, maximum: 30 } }
 *     responses:
 *       200: { description: "{ days, points: [{ at, onlineShare, samples }] }" }
 */
router.get(
  '/devices/:id/presence',
  validateParams(idParamSchema),
  validateQuery(presenceQuerySchema),
  getPresence
);
router.patch(
  '/devices/:id',
  validateParams(idParamSchema),
  validateBody(updateDeviceSchema),
  updateDevice
);

/**
 * @swagger
 * /discovery/scans:
 *   get:
 *     summary: Discovery scan history
 *     tags: [Discovery]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Paginated scans }
 *   post:
 *     summary: Start an nmap ping scan of an allowed local network
 *     description: Runs in the background; poll GET /discovery/scans/{id}. Only one scan runs at a time.
 *     tags: [Discovery]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target: { type: string, example: 192.168.100.0/24, description: Defaults to the first allowed network }
 *     responses:
 *       202: { description: Scan started }
 *       400: { description: Target outside the allowed networks }
 *       409: { description: A scan is already running }
 */
router.get('/discovery/scans', validateQuery(scanListQuerySchema), listScans);
router.post('/discovery/scans', validateBody(startScanSchema), startScan);

/**
 * @swagger
 * /discovery/scans/{id}:
 *   get:
 *     summary: One scan
 *     tags: [Discovery]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Scan }
 */
router.get('/discovery/scans/:id', validateParams(idParamSchema), getScan);

export default router;
