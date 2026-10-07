import { Router } from "express";
import { asyncHandler, sendData } from "../../lib/http";
import { currentUser, requireAuth } from "../../middleware/auth";
import { validate, validatedBody, validatedParams, validatedQuery } from "../../middleware/validate";
import { actionIdParamsSchema, executeActionSchema, scanQuerySchema, type ExecuteActionInput, type ScanQuery } from "./schema";
import * as service from "./service";

export const qualityRouter = Router();

qualityRouter.use(requireAuth);

// 数据质量体检：扫描日期越界、阶段缺失、孤立文件，输出分级建议（可复算）
qualityRouter.get(
  "/scan",
  validate({ query: scanQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.runScan(currentUser(req).id, validatedQuery<ScanQuery>(req)));
  }),
);

// 执行处置动作：按发现指纹执行，逐项写入回滚凭据
qualityRouter.post(
  "/actions",
  validate({ body: executeActionSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.executeAction(currentUser(req).id, validatedBody<ExecuteActionInput>(req)), undefined, 201);
  }),
);

qualityRouter.get(
  "/actions",
  asyncHandler(async (req, res) => {
    sendData(res, await service.listActions(currentUser(req).id));
  }),
);

qualityRouter.get(
  "/actions/:actionId",
  validate({ params: actionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.getAction(currentUser(req).id, validatedParams<{ actionId: string }>(req).actionId));
  }),
);

// 按回滚凭据撤销一次处置
qualityRouter.post(
  "/actions/:actionId/rollback",
  validate({ params: actionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.rollbackAction(currentUser(req).id, validatedParams<{ actionId: string }>(req).actionId));
  }),
);
