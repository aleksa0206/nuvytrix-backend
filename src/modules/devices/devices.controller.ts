import type { Request, Response } from 'express';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { requestContext } from '../../common/utils/requestContext';
import { container } from '../../container';

async function listDevicesHandler(_req: Request, res: Response) {
  res.json(await container.devicesService.listDevices(res.locals.query));
}

async function getDeviceHandler(_req: Request, res: Response) {
  res.json(await container.devicesService.getDevice(res.locals.params.id));
}

async function updateDeviceHandler(req: Request, res: Response) {
  const device = await container.devicesService.updateDevice(
    res.locals.params.id,
    req.body,
    req.admin!.adminId,
    requestContext(req)
  );
  res.json(device);
}

async function startScanHandler(req: Request, res: Response) {
  const scan = await container.devicesService.startScan(
    req.body.target,
    req.admin!.adminId,
    requestContext(req)
  );
  res.status(202).json(await container.devicesService.getScan(scan.id));
}

async function listScansHandler(_req: Request, res: Response) {
  res.json(await container.devicesService.listScans(res.locals.query));
}

async function getScanHandler(_req: Request, res: Response) {
  res.json(await container.devicesService.getScan(res.locals.params.id));
}

export const listDevices = asyncHandler(listDevicesHandler);
export const getDevice = asyncHandler(getDeviceHandler);
export const updateDevice = asyncHandler(updateDeviceHandler);
export const startScan = asyncHandler(startScanHandler);
export const listScans = asyncHandler(listScansHandler);
export const getScan = asyncHandler(getScanHandler);
