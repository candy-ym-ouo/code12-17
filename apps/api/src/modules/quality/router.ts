import { z } from "zod";
import { Router } from "express";
import { asyncHandler, sendData } from "../../lib/http";
import { currentUser, requireAuth } from "../../middleware/auth";
import { validate, validatedBody, validatedParams, validatedQuery } from "../../middleware/validate";
import {
  applyActionBodySchema,
  listFindingsQuerySchema,
  listReportsQuerySchema,
  scanBodySchema,
  type ApplyActionBody,
  type ListFindingsQuery,
  type ListReportsQuery,
  type ScanBody,
} from "./schema";
import * as service from "./service";

export const qualityRouter = Router();

qualityRouter.use(requireAuth);

const idParams = z.object({ id: z.string().min(1) });
const actionParams = z.object({ actionId: z.string().min(1) });

qualityRouter.get(
  "/findings",
  validate({ query: listFindingsQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await service.listFindings(currentUser(req).id, validatedQuery<ListFindingsQuery>(req));
    sendData(res, result.items, result.meta);
  }),
);

qualityRouter.get(
  "/findings/:id",
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    sendData(res, await service.getFinding(currentUser(req).id, id));
  }),
);

qualityRouter.post(
  "/scan",
  validate({ body: scanBodySchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const result = await service.scan(user.id, user.role, validatedBody<ScanBody>(req));
    sendData(res, result, undefined, 201);
  }),
);

qualityRouter.post(
  "/recompute",
  asyncHandler(async (req, res) => {
    sendData(res, await service.recompute(currentUser(req).id));
  }),
);

qualityRouter.post(
  "/findings/:id/actions",
  validate({ params: idParams, body: applyActionBodySchema }),
  asyncHandler(async (req, res) => {
    const { id } = validatedParams<{ id: string }>(req);
    const result = await service.applyAction(currentUser(req).id, id, validatedBody<ApplyActionBody>(req));
    sendData(res, result, undefined, 201);
  }),
);

qualityRouter.post(
  "/actions/:actionId/rollback",
  validate({ params: actionParams }),
  asyncHandler(async (req, res) => {
    const { actionId } = validatedParams<{ actionId: string }>(req);
    sendData(res, await service.rollback(currentUser(req).id, actionId));
  }),
);

qualityRouter.get(
  "/actions",
  validate({
    query: z.object({
      findingId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = validatedQuery<{ findingId?: string; limit: number; offset: number }>(req);
    const result = await service.listActions(currentUser(req).id, query);
    sendData(res, result.items, result.meta);
  }),
);

qualityRouter.get(
  "/reports",
  validate({ query: listReportsQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await service.listReports(currentUser(req).id, validatedQuery<ListReportsQuery>(req));
    sendData(res, result.items, result.meta);
  }),
);
