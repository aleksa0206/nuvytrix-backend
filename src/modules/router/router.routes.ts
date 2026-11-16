import { Router } from 'express';
import { z } from 'zod';
import { ConflictError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { requireAuth } from '../../common/middleware/auth';
import { validateBody, validateParams, validateQuery } from '../../common/middleware/validate';
import { requestContext } from '../../common/utils/requestContext';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { container } from '../../container';
import {
  ipFilterRuleSchema,
  ipFilterSettingsSchema,
  ruleIndexSchema,
} from './routerFirewall.schema';
import { dhcpReservationSchema, dhcpServerSchema } from './routerDhcp.schema';

const router = Router();
router.use(requireAuth);

const historyQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24),
});

/**
 * @swagger
 * /router/status:
 *   get:
 *     summary: Latest reading of the Huawei router (system, optics, WAN, ports, Wi-Fi, IPv4 filter)
 *     description: >
 *       Read through the router's web UI and UPnP on a schedule. Returns configured=false when
 *       ROUTER_USERNAME/ROUTER_PASSWORD are not set. Sections that could not be read are listed in errors.
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Status }
 * /router/clients:
 *   get:
 *     summary: Devices known to the router, with Wi-Fi signal data and the matching Nuvytrix device
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Clients }
 *       503: { description: Not configured or not polled yet }
 * /router/upnp:
 *   get:
 *     summary: Port mappings opened through UPnP
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Mappings }
 * /router/history:
 *   get:
 *     summary: Stored router samples (CPU, memory, optics, WAN rate, clients)
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: query, name: hours, schema: { type: integer, default: 24 } }
 *     responses:
 *       200: { description: Samples }
 * /router/refresh:
 *   post:
 *     summary: Poll the router now
 *     tags: [Router]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Fresh status }
 *       409: { description: A poll is already running }
 */
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(container.routerService.getStatus());
  })
);
router.get(
  '/clients',
  asyncHandler(async (_req, res) => {
    res.json(await container.routerService.getClients());
  })
);
router.get(
  '/upnp',
  asyncHandler(async (_req, res) => {
    res.json(await container.routerService.getPortMappings());
  })
);
router.get(
  '/history',
  validateQuery(historyQuerySchema),
  asyncHandler(async (_req, res) => {
    res.json(await container.routerService.getHistory(res.locals.query.hours));
  })
);
router.post(
  '/refresh',
  asyncHandler(async (_req, res) => {
    if (container.routerService.isPolling) throw new ConflictError(ErrorCode.ROUTER_POLL_RUNNING);
    await container.routerService.poll();
    res.json(container.routerService.getStatus());
  })
);

/**
 * @swagger
 * /router/firewall:
 *   get:
 *     summary: IPv4 filter read from the router now, and whether Nuvytrix may change it
 *     tags: [Router firewall]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Filter state }
 *       503: { description: Router not configured or not reachable }
 *   patch:
 *     summary: Turn the IPv4 filter on or off, or set blacklist mode
 *     description: Read back after saving; 502 if the router does not show the change. Audited.
 *     tags: [Router firewall]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *               mode: { type: string, enum: [blacklist] }
 *     responses:
 *       200: { description: New state }
 *       403: { description: ROUTER_WRITES_ENABLED is off }
 *       422: { description: Refused (not blacklist mode) }
 *       502: { description: The router did not apply the change }
 * /router/firewall/rules:
 *   post:
 *     summary: Add an IPv4 filter rule on the router (blacklist mode)
 *     description: >
 *       Refused when the LAN range covers the router or a protected address, or when the same rule
 *       or name exists. Read back after saving. Audited.
 *     tags: [Router firewall]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, protocol]
 *             properties:
 *               name: { type: string }
 *               protocol: { type: string, enum: [ALL, TCP/UDP, TCP, UDP, ICMP] }
 *               lanIpStart: { type: string }
 *               lanIpEnd: { type: string }
 *               wanIpStart: { type: string }
 *               wanIpEnd: { type: string }
 *               lanTcpPorts: { type: string, example: '80,443,8000:8080' }
 *               lanUdpPorts: { type: string }
 *               wanTcpPorts: { type: string }
 *               wanUdpPorts: { type: string }
 *     responses:
 *       201: { description: Rule as stored on the router }
 * /router/firewall/rules/{index}:
 *   put:
 *     summary: Replace an IPv4 filter rule (index from the rule's domain, IpFilterIn.{index})
 *     tags: [Router firewall]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated rule }
 *       404: { description: No such rule on the router }
 *   delete:
 *     summary: Delete an IPv4 filter rule; the deleted rule is kept in the audit log
 *     tags: [Router firewall]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: New state }
 */
router.get(
  '/firewall',
  asyncHandler(async (_req, res) => {
    const service = container.routerFirewallService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.patch(
  '/firewall',
  validateBody(ipFilterSettingsSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerFirewallService.changeSettings(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);
router.post(
  '/firewall/rules',
  validateBody(ipFilterRuleSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerFirewallService.addRule(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result);
  })
);
router.put(
  '/firewall/rules/:index',
  validateParams(ruleIndexSchema),
  validateBody(ipFilterRuleSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerFirewallService.updateRule(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result);
  })
);
router.delete(
  '/firewall/rules/:index',
  validateParams(ruleIndexSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerFirewallService.deleteRule(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/dhcp:
 *   get:
 *     summary: Main DHCP pool and static reservations, read from the router now
 *     tags: [Router DHCP]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: DHCP state and whether Nuvytrix may change it }
 *       503: { description: Router not configured or not reachable }
 *   patch:
 *     summary: Change the main DHCP pool range and lease time
 *     description: >
 *       Refused when the pool leaves the LAN subnet, includes the router, or would leave out a
 *       protected address or a reservation. Read back after saving. Audited.
 *     tags: [Router DHCP]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [startIp, endIp, leaseSeconds]
 *             properties:
 *               startIp: { type: string }
 *               endIp: { type: string }
 *               leaseSeconds: { type: integer, minimum: 60, maximum: 6048000 }
 *     responses:
 *       200: { description: New DHCP server state }
 *       403: { description: ROUTER_WRITES_ENABLED is off }
 *       422: { description: Refused }
 *       502: { description: The router did not apply the change }
 * /router/dhcp/reservations:
 *   post:
 *     summary: Reserve an address for a MAC address
 *     description: Refused when the address is outside the LAN, reserved, or held by another device.
 *     tags: [Router DHCP]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mac, ip]
 *             properties:
 *               mac: { type: string, example: 'aa:bb:cc:dd:ee:ff' }
 *               ip: { type: string, example: '192.168.100.50' }
 *     responses:
 *       201: { description: Reservation as stored on the router }
 * /router/dhcp/reservations/{index}:
 *   put:
 *     summary: Change a reservation (index from DHCPStaticAddress.{index})
 *     tags: [Router DHCP]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated reservation }
 *       404: { description: No such reservation on the router }
 *   delete:
 *     summary: Delete a reservation; it is kept in the audit log
 *     tags: [Router DHCP]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Remaining reservations }
 */
router.get(
  '/dhcp',
  asyncHandler(async (_req, res) => {
    const service = container.routerDhcpService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.patch(
  '/dhcp',
  validateBody(dhcpServerSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDhcpService.changeServer(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);
router.post(
  '/dhcp/reservations',
  validateBody(dhcpReservationSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDhcpService.addReservation(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result);
  })
);
router.put(
  '/dhcp/reservations/:index',
  validateParams(ruleIndexSchema),
  validateBody(dhcpReservationSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDhcpService.updateReservation(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result);
  })
);
router.delete(
  '/dhcp/reservations/:index',
  validateParams(ruleIndexSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDhcpService.deleteReservation(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

export default router;
