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
import {
  macFilterEntryParamsSchema,
  macFilterEntrySchema,
  macFilterListSchema,
  macFilterSettingsSchema,
} from './routerMacFilter.schema';
import { portMappingIndexSchema, portMappingSchema } from './routerPortMapping.schema';
import { dmzSchema, portTriggerSchema, triggerIndexSchema } from './routerForwarding.schema';
import { wifiCreateSchema, wifiIndexSchema, wifiUpdateSchema } from './routerWifi.schema';
import { wifiScheduleSchema } from './routerWifiSchedule.service';
import { CHANNELS, POWER_LEVELS, wifiRadioSchema } from './routerWifiRadio.service';
import { ledSchema } from './routerLed.service';
import { diagnosticsSchema } from './routerDiagnostics.service';
import {
  parentalDeviceParams,
  parentalDeviceSchema,
  parentalItemParams,
  parentalPeriodSchema,
  parentalTemplateParams,
  parentalTemplateSchema,
  parentalTemplateUpdateSchema,
  parentalUrlSchema,
} from './routerParental.schema';
import { dnsHostIndexSchema, dnsHostSchema } from './routerDns.schema';
import { ddnsCreateSchema, ddnsIndexSchema, ddnsUpdateSchema } from './routerDdns.schema';

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

/**
 * @swagger
 * /router/mac-filter:
 *   get:
 *     summary: LAN and Wi-Fi MAC filters and the active Wi-Fi networks, read from the router now
 *     tags: [Router MAC filter]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Both lists and whether Nuvytrix may change them }
 * /router/mac-filter/{list}:
 *   patch:
 *     summary: Turn a MAC filter on or off (blacklist mode only)
 *     description: Refused while the list holds the server or admin PC. Read back; audited.
 *     tags: [Router MAC filter]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: list, required: true, schema: { type: string, enum: [lan, wifi] } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, required: [enabled], properties: { enabled: { type: boolean } } }
 *     responses:
 *       200: { description: New state of the list }
 *       422: { description: Refused }
 * /router/mac-filter/{list}/entries:
 *   post:
 *     summary: Add a MAC address to a blacklist
 *     description: The device holding a protected address (server, admin PC) is refused.
 *     tags: [Router MAC filter]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: list, required: true, schema: { type: string, enum: [lan, wifi] } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mac]
 *             properties:
 *               mac: { type: string }
 *               name: { type: string }
 *               ssid: { type: string, example: SSID-1, description: Wi-Fi list only }
 *     responses:
 *       201: { description: Entry as stored on the router }
 * /router/mac-filter/{list}/entries/{index}:
 *   put:
 *     summary: Change an entry
 *     tags: [Router MAC filter]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: list, required: true, schema: { type: string, enum: [lan, wifi] } }
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated entry }
 *       404: { description: No such entry on the router }
 *   delete:
 *     summary: Delete an entry; it is kept in the audit log
 *     tags: [Router MAC filter]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: list, required: true, schema: { type: string, enum: [lan, wifi] } }
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: New state of the list }
 */
router.get(
  '/mac-filter',
  asyncHandler(async (_req, res) => {
    const service = container.routerMacFilterService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.patch(
  '/mac-filter/:list',
  validateParams(macFilterListSchema),
  validateBody(macFilterSettingsSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerMacFilterService.setEnabled(
      res.locals.params.list,
      req.body.enabled,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);
router.post(
  '/mac-filter/:list/entries',
  validateParams(macFilterListSchema),
  validateBody(macFilterEntrySchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerMacFilterService.addEntry(
      res.locals.params.list,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result);
  })
);
router.put(
  '/mac-filter/:list/entries/:index',
  validateParams(macFilterEntryParamsSchema),
  validateBody(macFilterEntrySchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerMacFilterService.updateEntry(
      res.locals.params.list,
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result);
  })
);
router.delete(
  '/mac-filter/:list/entries/:index',
  validateParams(macFilterEntryParamsSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerMacFilterService.deleteEntry(
      res.locals.params.list,
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/port-mappings:
 *   get:
 *     summary: IPv4 port mappings (port forwarding), read from the router now
 *     tags: [Router port mapping]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Mappings, the internet WAN they are created on, and whether Nuvytrix may change them }
 *   post:
 *     summary: Forward external ports on the internet WAN to a LAN device
 *     description: >
 *       Refused for the router itself, addresses outside the LAN, a duplicate name, or external
 *       ports another mapping already uses. Read back after saving. Audited.
 *     tags: [Router port mapping]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, enabled, protocol, internalHost, internalPort, externalPortStart, externalPortEnd]
 *             properties:
 *               name: { type: string }
 *               enabled: { type: boolean }
 *               protocol: { type: string, enum: [TCP, UDP, TCP/UDP] }
 *               internalHost: { type: string }
 *               internalPort: { type: integer }
 *               externalPortStart: { type: integer }
 *               externalPortEnd: { type: integer }
 *               remoteHostStart: { type: string }
 *               remoteHostEnd: { type: string }
 *     responses:
 *       201: { description: Mapping as stored on the router }
 * /router/port-mappings/{index}:
 *   put:
 *     summary: Change a mapping (index from PortMapping.{index}); only mappings with one port range
 *     tags: [Router port mapping]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated mapping }
 *       404: { description: No such mapping on the router }
 *   delete:
 *     summary: Delete a mapping; it is kept in the audit log
 *     tags: [Router port mapping]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Remaining mappings }
 */
router.get(
  '/port-mappings',
  asyncHandler(async (_req, res) => {
    const service = container.routerPortMappingService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.post(
  '/port-mappings',
  validateBody(portMappingSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerPortMappingService.addMapping(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result);
  })
);
router.put(
  '/port-mappings/:index',
  validateParams(portMappingIndexSchema),
  validateBody(portMappingSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerPortMappingService.updateMapping(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result);
  })
);
router.delete(
  '/port-mappings/:index',
  validateParams(portMappingIndexSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerPortMappingService.deleteMapping(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/dmz:
 *   get:
 *     summary: DMZ host on the internet WAN, read from the router now (null when none)
 *     tags: [Router DMZ and port trigger]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: DMZ state and whether Nuvytrix may change it }
 *   put:
 *     summary: Set the DMZ host and turn it on or off
 *     description: >
 *       A DMZ host receives every unsolicited connection from the internet. Refused for the router,
 *       addresses outside the LAN, and protected addresses (server, admin PC). Read back; audited.
 *     tags: [Router DMZ and port trigger]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled, host]
 *             properties:
 *               enabled: { type: boolean }
 *               host: { type: string }
 *     responses:
 *       200: { description: New DMZ state }
 *       422: { description: Refused }
 *   delete:
 *     summary: Remove the DMZ entry; it is kept in the audit log
 *     tags: [Router DMZ and port trigger]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Removed }
 *       404: { description: No DMZ entry on the router }
 * /router/port-triggers:
 *   get:
 *     summary: Port triggers on the internet WAN, read from the router now
 *     tags: [Router DMZ and port trigger]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Triggers and whether Nuvytrix may change them }
 *   post:
 *     summary: Add a port trigger
 *     description: Ranges may not overlap another trigger; the router allows 256 ports per side in total.
 *     tags: [Router DMZ and port trigger]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *               triggerProtocol: { type: string, enum: [TCP, UDP, TCP/UDP] }
 *               triggerPortStart: { type: integer }
 *               triggerPortEnd: { type: integer }
 *               openProtocol: { type: string, enum: [TCP, UDP, TCP/UDP] }
 *               openPortStart: { type: integer }
 *               openPortEnd: { type: integer }
 *     responses:
 *       201: { description: Trigger as stored on the router }
 * /router/port-triggers/{index}:
 *   put:
 *     summary: Change a port trigger (index from X_HW_PortTrigger.{index})
 *     tags: [Router DMZ and port trigger]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated trigger }
 *   delete:
 *     summary: Delete a port trigger; it is kept in the audit log
 *     tags: [Router DMZ and port trigger]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Remaining triggers }
 */
router.get(
  '/dmz',
  asyncHandler(async (_req, res) => {
    const service = container.routerForwardingService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getDmz()) });
  })
);
router.put(
  '/dmz',
  validateBody(dmzSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerForwardingService.setDmz(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.dmz);
  })
);
router.delete(
  '/dmz',
  asyncHandler(async (req, res) => {
    await container.routerForwardingService.deleteDmz(req.admin!.adminId, requestContext(req));
    res.status(204).end();
  })
);
router.get(
  '/port-triggers',
  asyncHandler(async (_req, res) => {
    const service = container.routerForwardingService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getTriggers()) });
  })
);
router.post(
  '/port-triggers',
  validateBody(portTriggerSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerForwardingService.addTrigger(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result);
  })
);
router.put(
  '/port-triggers/:index',
  validateParams(triggerIndexSchema),
  validateBody(portTriggerSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerForwardingService.updateTrigger(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result);
  })
);
router.delete(
  '/port-triggers/:index',
  validateParams(triggerIndexSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerForwardingService.deleteTrigger(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/wifi:
 *   get:
 *     summary: Wi-Fi networks on both bands, read from the router now (never their keys)
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Networks and whether Nuvytrix may change them }
 *   post:
 *     summary: Add a Wi-Fi network with WPA2 or WPA/WPA2 and a key
 *     description: >
 *       Created switched off, then secured in a second request; removed again if securing fails.
 *       The key is written to the router and compared on read-back; it is never stored or returned.
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [band, ssid, enabled, visible, security, password]
 *             properties:
 *               band: { type: string, enum: ['2.4 GHz', '5 GHz'] }
 *               ssid: { type: string, maxLength: 32 }
 *               enabled: { type: boolean }
 *               visible: { type: boolean }
 *               security: { type: string, enum: [wpa2, wpa-wpa2] }
 *               password: { type: string, minLength: 8, maxLength: 63 }
 *     responses:
 *       201: { description: The new network }
 * /router/wifi/{index}:
 *   put:
 *     summary: Change a network (index from WLANConfiguration.{index}); password optional
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Updated network }
 *       404: { description: No such network }
 *   delete:
 *     summary: Remove an extra network; the main network of each band cannot be removed
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     parameters:
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: Remaining networks }
 */
router.get(
  '/wifi',
  asyncHandler(async (_req, res) => {
    const service = container.routerWifiService;
    res.json({ writesEnabled: service.writesEnabled, networks: await service.getNetworks() });
  })
);
router.post(
  '/wifi',
  validateBody(wifiCreateSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerWifiService.addNetwork(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json({ network: result.network });
  })
);
router.put(
  '/wifi/:index',
  validateParams(wifiIndexSchema),
  validateBody(wifiUpdateSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerWifiService.updateNetwork(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json({ network: result.network });
  })
);
router.delete(
  '/wifi/:index',
  validateParams(wifiIndexSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerWifiService.deleteNetwork(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/parental:
 *   get:
 *     summary: Parental control templates (time periods, URL lists) and bound devices, read now
 *     tags: [Router parental control]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Templates, devices and whether Nuvytrix may change them }
 * /router/parental/templates:
 *   post:
 *     summary: Add a template ({ name })
 *     tags: [Router parental control]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       201: { description: The new template }
 * /router/parental/templates/{template}:
 *   patch:
 *     summary: Rename a template or switch its time / URL control and mode (block or allow)
 *     tags: [Router parental control]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Updated template }
 *   delete:
 *     summary: Delete a template that no device uses
 *     tags: [Router parental control]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: New state }
 * /router/parental/templates/{template}/periods:
 *   post:
 *     summary: Add a time period ({ start HH:MM, end HH:MM, days 1=Mon … 7=Sun })
 *     tags: [Router parental control]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       201: { description: The new period }
 * /router/parental/templates/{template}/urls:
 *   post:
 *     summary: Add a site to the template's URL list ({ url })
 *     tags: [Router parental control]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       201: { description: The new entry }
 * /router/parental/devices:
 *   post:
 *     summary: Bind a device to a template ({ mac, description, template }); not the server or admin PC
 *     tags: [Router parental control]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       201: { description: The binding }
 */
router.get(
  '/parental',
  asyncHandler(async (_req, res) => {
    const service = container.routerParentalService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.post(
  '/parental/templates',
  validateBody(parentalTemplateSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.addTemplate(
      req.body.name,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result.template);
  })
);
router.patch(
  '/parental/templates/:template',
  validateParams(parentalTemplateParams),
  validateBody(parentalTemplateUpdateSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.updateTemplate(
      res.locals.params.template,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.template);
  })
);
router.delete(
  '/parental/templates/:template',
  validateParams(parentalTemplateParams),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.deleteTemplate(
      res.locals.params.template,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);
router.post(
  '/parental/templates/:template/periods',
  validateParams(parentalTemplateParams),
  validateBody(parentalPeriodSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.addPeriod(
      res.locals.params.template,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result.period);
  })
);
router.delete(
  '/parental/templates/:template/periods/:item',
  validateParams(parentalItemParams),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.deletePeriod(
      res.locals.params.template,
      res.locals.params.item,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);
router.post(
  '/parental/templates/:template/urls',
  validateParams(parentalTemplateParams),
  validateBody(parentalUrlSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.addUrl(
      res.locals.params.template,
      req.body.url,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result.url);
  })
);
router.delete(
  '/parental/templates/:template/urls/:item',
  validateParams(parentalItemParams),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.deleteUrl(
      res.locals.params.template,
      res.locals.params.item,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);
router.post(
  '/parental/devices',
  validateBody(parentalDeviceSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.addDevice(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result.device);
  })
);
router.put(
  '/parental/devices/:index',
  validateParams(parentalDeviceParams),
  validateBody(parentalDeviceSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.updateDevice(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.device);
  })
);
router.delete(
  '/parental/devices/:index',
  validateParams(parentalDeviceParams),
  asyncHandler(async (req, res) => {
    const result = await container.routerParentalService.deleteDevice(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/dns-hosts:
 *   get:
 *     summary: Static DNS entries on the router, read now
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Entries and whether Nuvytrix may change them }
 *   post:
 *     summary: Add a static DNS entry ({ name, ip }); at most 20, one per name
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       201: { description: The new entry }
 * /router/dns-hosts/{index}:
 *   put:
 *     summary: Change a static DNS entry
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Updated entry }
 *   delete:
 *     summary: Delete a static DNS entry; it is kept in the audit log
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Remaining entries }
 */
router.get(
  '/dns-hosts',
  asyncHandler(async (_req, res) => {
    const service = container.routerDnsService;
    res.json({ writesEnabled: service.writesEnabled, hosts: await service.getHosts() });
  })
);
router.post(
  '/dns-hosts',
  validateBody(dnsHostSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDnsService.addHost(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result.host);
  })
);
router.put(
  '/dns-hosts/:index',
  validateParams(dnsHostIndexSchema),
  validateBody(dnsHostSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDnsService.updateHost(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.host);
  })
);
router.delete(
  '/dns-hosts/:index',
  validateParams(dnsHostIndexSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDnsService.deleteHost(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/ddns:
 *   get:
 *     summary: Dynamic DNS entries on the internet WAN, read now (never their passwords)
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Entries and whether Nuvytrix may change them }
 *   post:
 *     summary: Add a DDNS entry ({ enabled, provider, username, password, domainName, serverHost, port })
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       201: { description: The new entry }
 * /router/ddns/{index}:
 *   put:
 *     summary: Change a DDNS entry; the password stays unchanged when left out
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Updated entry }
 *   delete:
 *     summary: Delete a DDNS entry; it is kept in the audit log (without its password)
 *     tags: [Router DNS]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Remaining entries }
 */
router.get(
  '/ddns',
  asyncHandler(async (_req, res) => {
    const service = container.routerDdnsService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.post(
  '/ddns',
  validateBody(ddnsCreateSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDdnsService.addEntry(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.status(201).json(result.entry);
  })
);
router.put(
  '/ddns/:index',
  validateParams(ddnsIndexSchema),
  validateBody(ddnsUpdateSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDdnsService.updateEntry(
      res.locals.params.index,
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.entry);
  })
);
router.delete(
  '/ddns/:index',
  validateParams(ddnsIndexSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerDdnsService.deleteEntry(
      res.locals.params.index,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/upnp-settings:
 *   get:
 *     summary: Whether UPnP is on, read from the router now
 *     tags: [Router UPnP]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: UPnP state and whether Nuvytrix may change it }
 *   patch:
 *     summary: Turn UPnP on or off
 *     description: >
 *       Nuvytrix reads WAN status and live port mappings over UPnP; they are unavailable while it
 *       is off. Read back after saving; audited.
 *     tags: [Router UPnP]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: New state }
 */
router.get(
  '/upnp-settings',
  asyncHandler(async (_req, res) => {
    const service = container.routerUpnpService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.patch(
  '/upnp-settings',
  validateBody(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    const result = await container.routerUpnpService.setEnabled(
      req.body.enabled,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/wifi-schedule:
 *   get:
 *     summary: Automatic Wi-Fi shutdown periods and whether they are active, read now
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Schedule and whether Nuvytrix may change it }
 *   put:
 *     summary: Replace the shutdown periods (at most four) and switch the schedule on or off
 *     description: >
 *       While the schedule is on, the router switches Wi-Fi off during each period (wired devices
 *       are not affected). Read back after saving; audited.
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: New schedule }
 */
router.get(
  '/wifi-schedule',
  asyncHandler(async (_req, res) => {
    const service = container.routerWifiScheduleService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getSchedule()) });
  })
);
router.put(
  '/wifi-schedule',
  validateBody(wifiScheduleSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerWifiScheduleService.setSchedule(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/wifi-radios:
 *   get:
 *     summary: Channel and transmit power per Wi-Fi band, with the values Nuvytrix offers
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: Radios, offered channels and power levels }
 *   put:
 *     summary: Set a band's channel (auto or manual) and transmit power
 *     description: Restarts that radio, so its Wi-Fi devices drop for a moment. Read back; audited.
 *     tags: [Router Wi-Fi]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: The radio as read back }
 */
router.get(
  '/wifi-radios',
  asyncHandler(async (_req, res) => {
    const service = container.routerWifiRadioService;
    res.json({
      writesEnabled: service.writesEnabled,
      radios: await service.getRadios(),
      channels: CHANNELS,
      powerLevels: POWER_LEVELS,
    });
  })
);
router.put(
  '/wifi-radios',
  validateBody(wifiRadioSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerWifiRadioService.setRadio(
      req.body,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.radio);
  })
);

/**
 * @swagger
 * /router/led:
 *   get:
 *     summary: The router's indicator lights (on or off), read now
 *     tags: [Router maintenance]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: LED mode and whether Nuvytrix may change it }
 *   put:
 *     summary: Set the indicator lights mode
 *     tags: [Router maintenance]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: New mode }
 */
router.get(
  '/led',
  asyncHandler(async (_req, res) => {
    const service = container.routerLedService;
    res.json({ writesEnabled: service.writesEnabled, ...(await service.getState()) });
  })
);
router.put(
  '/led',
  validateBody(ledSchema),
  asyncHandler(async (req, res) => {
    const result = await container.routerLedService.setMode(
      req.body.mode,
      req.admin!.adminId,
      requestContext(req)
    );
    res.json(result.state);
  })
);

/**
 * @swagger
 * /router/diagnostics:
 *   post:
 *     summary: Run a ping or traceroute from the router itself ({ kind, host }) and wait for it
 *     description: >
 *       Changes no setting. Waits up to 90 seconds; a state of Requested means the router was still
 *       running the test. Audited.
 *     tags: [Router maintenance]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: "{ state, output }" }
 * /router/user-log:
 *   get:
 *     summary: The router's user log entries (the header with serial number is left out)
 *     tags: [Router maintenance]
 *     security: [{ cookieAuth: [] }]
 *     responses:
 *       200: { description: "{ entries }" }
 */
router.post(
  '/diagnostics',
  validateBody(diagnosticsSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await container.routerDiagnosticsService.run(
        req.body,
        req.admin!.adminId,
        requestContext(req)
      )
    );
  })
);
router.get(
  '/user-log',
  asyncHandler(async (_req, res) => {
    res.json({ entries: await container.routerDiagnosticsService.userLog() });
  })
);

export default router;
