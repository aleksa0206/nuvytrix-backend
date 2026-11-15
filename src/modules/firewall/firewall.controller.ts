import type { Request, Response } from 'express';
import { ValidationError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { asyncHandler } from '../../common/utils/asyncHandler';
import { requestContext } from '../../common/utils/requestContext';
import { container } from '../../container';

async function importLogHandler(req: Request, res: Response) {
  if (!req.file) throw new ValidationError(ErrorCode.FIREWALL_FILE_REQUIRED);
  const result = await container.firewallService.importLog(
    { originalName: req.file.originalname, buffer: req.file.buffer },
    req.admin!.adminId,
    requestContext(req)
  );
  res.status(201).json(result);
}

async function listImportsHandler(_req: Request, res: Response) {
  res.json(await container.firewallService.listImports(res.locals.query));
}

async function getImportHandler(_req: Request, res: Response) {
  res.json(await container.firewallService.getImport(res.locals.params.id));
}

async function listEventsHandler(_req: Request, res: Response) {
  res.json(await container.firewallService.listEvents(res.locals.query));
}

async function getEventHandler(_req: Request, res: Response) {
  res.json(await container.firewallService.getEvent(res.locals.params.id));
}

async function getFacetsHandler(_req: Request, res: Response) {
  res.json(await container.firewallService.getFacets());
}

async function getSummaryHandler(_req: Request, res: Response) {
  const { from, to } = res.locals.query;
  res.json(await container.firewallService.getSummary(from, to));
}

async function getInsightsHandler(_req: Request, res: Response) {
  const { from, to } = res.locals.query;
  res.json(await container.firewallService.getInsights(from, to));
}

async function listPoliciesHandler(_req: Request, res: Response) {
  res.json(await container.policiesService.list());
}

async function getPolicyHandler(_req: Request, res: Response) {
  res.json(await container.policiesService.get(res.locals.params.id));
}

async function createPolicyHandler(req: Request, res: Response) {
  const policy = await container.policiesService.create(
    req.body,
    req.admin!.adminId,
    requestContext(req)
  );
  res.status(201).json(policy);
}

async function updatePolicyHandler(req: Request, res: Response) {
  const policy = await container.policiesService.update(
    res.locals.params.id,
    req.body,
    req.admin!.adminId,
    requestContext(req)
  );
  res.json(policy);
}

async function changePolicyStatusHandler(req: Request, res: Response) {
  const policy = await container.policiesService.changeStatus(
    res.locals.params.id,
    req.body,
    req.admin!.adminId,
    requestContext(req)
  );
  res.json(policy);
}

async function deletePolicyHandler(req: Request, res: Response) {
  await container.policiesService.delete(
    res.locals.params.id,
    req.body.confirm,
    req.admin!.adminId,
    requestContext(req)
  );
  res.status(204).end();
}

async function policyInstructionsHandler(_req: Request, res: Response) {
  res.json(await container.policiesService.instructions(res.locals.params.id));
}

export const importLog = asyncHandler(importLogHandler);
export const listImports = asyncHandler(listImportsHandler);
export const getImport = asyncHandler(getImportHandler);
export const listEvents = asyncHandler(listEventsHandler);
export const getEvent = asyncHandler(getEventHandler);
export const getFacets = asyncHandler(getFacetsHandler);
export const getSummary = asyncHandler(getSummaryHandler);
export const getInsights = asyncHandler(getInsightsHandler);
export const listPolicies = asyncHandler(listPoliciesHandler);
export const getPolicy = asyncHandler(getPolicyHandler);
export const createPolicy = asyncHandler(createPolicyHandler);
export const updatePolicy = asyncHandler(updatePolicyHandler);
export const changePolicyStatus = asyncHandler(changePolicyStatusHandler);
export const deletePolicy = asyncHandler(deletePolicyHandler);
export const policyInstructions = asyncHandler(policyInstructionsHandler);
