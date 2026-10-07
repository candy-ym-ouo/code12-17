import { Prisma } from "@prisma/client";
import { dateStringToUtc, isValidDateString } from "../../lib/date";
import { ApiError } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { storage } from "../../lib/storage";
import type { SuggestedAction } from "./rules";

export const APPLIED_ACTIONS = ["FIX_DATE", "SYNC_OBSERVED_AT", "SET_PHENOPHASE", "QUARANTINE_FILE", "DROP_PHOTO_ROW", "DISMISS"] as const;
export type AppliedAction = (typeof APPLIED_ACTIONS)[number];

export interface ApplyParams {
  action: AppliedAction;
  /** FIX_DATE：指定新日期；缺省时尝试用 observedAt 兜底。 */
  newDate?: string;
  /** SET_PHENOPHASE：目标阶段（会校验物种归属）。 */
  phenophaseId?: string;
  /** 同时补齐物种（阶段与物种必须一起自洽）。 */
  speciesId?: string;
  reason?: string;
}

async function getOwnedFinding(ownerId: string, findingId: string) {
  const finding = await prisma.qualityFinding.findFirst({ where: { id: findingId, ownerId } });
  if (!finding) throw new ApiError(404, "NOT_FOUND", "体检问题不存在");
  return finding;
}

function recordAction(data: Prisma.QualityActionUncheckedCreateInput) {
  return prisma.qualityAction.create({ data });
}

/**
 * 处置一条体检问题。
 * 任何修改数据的动作都先把"改之前"的完整快照写入 QualityAction.beforeSnapshot，
 * 之后凭该凭据可以 rollback，凭据不物理删除（rolledBackAt / rollbackResult 留痕）。
 */
export async function applyFindingAction(ownerId: string, findingId: string, params: ApplyParams) {
  const finding = await getOwnedFinding(ownerId, findingId);
  if (finding.status === "RESOLVED") throw new ApiError(409, "FINDING_CLOSED", "该问题已消解，无需处置");

  switch (params.action) {
    case "DISMISS":
      return dismiss(finding.id, ownerId, params.reason);
    case "FIX_DATE":
      return fixDate(finding.id, ownerId, finding.ruleCode, finding.entityId, params);
    case "SYNC_OBSERVED_AT":
      return syncObservedAt(finding.id, ownerId, finding.entityId);
    case "SET_PHENOPHASE":
      return setPhenophase(finding.id, ownerId, finding.entityId, params);
    case "QUARANTINE_FILE":
      return quarantineFile(finding.id, ownerId, finding);
    case "DROP_PHOTO_ROW":
      return dropPhotoRow(finding.id, ownerId, finding);
    default:
      throw new ApiError(400, "UNSUPPORTED_ACTION", "不支持的处置动作");
  }
}

async function dismiss(findingId: string, ownerId: string, reason?: string) {
  const action = await recordAction({
    findingId,
    ownerId,
    action: "DISMISS",
    status: "APPLIED",
    params: JSON.stringify({ reason: reason ?? null }),
    beforeSnapshot: JSON.stringify({ status: "OPEN" }),
  });
  await prisma.qualityFinding.update({
    where: { id: findingId },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });
  return { actionId: action.id, findingStatus: "DISMISSED" as const, reversible: true };
}

async function fixDate(
  findingId: string,
  ownerId: string,
  ruleCode: string,
  entityId: string | null,
  params: ApplyParams,
) {
  if (!entityId) throw new ApiError(400, "ACTION_NOT_APPLICABLE", "该问题没有关联的观测记录");
  const observation = await prisma.observation.findFirst({ where: { id: entityId, ownerId } });
  if (!observation) throw new ApiError(404, "NOT_FOUND", "关联的观测记录已不存在，可重新体检确认");

  let nextDate = params.newDate;
  if (!nextDate && observation.observedAt) nextDate = observation.observedAt.toISOString().slice(0, 10);
  if (!nextDate) {
    throw new ApiError(400, "NEW_DATE_REQUIRED", "该记录没有可兜底的 observedAt，请显式提供正确日期");
  }
  if (!isValidDateString(nextDate)) throw new ApiError(400, "INVALID_DATE", "提供的日期不是合法的 YYYY-MM-DD");

  const before = {
    id: observation.id,
    observationDate: observation.observationDate,
    observedAt: observation.observedAt?.toISOString() ?? null,
  };

  const updated = await prisma.observation.update({
    where: { id: observation.id },
    data: { observationDate: nextDate },
  });

  const action = await recordAction({
    findingId,
    ownerId,
    action: "FIX_DATE",
    params: JSON.stringify({ ruleCode, newDate: nextDate, reason: params.reason ?? null }),
    beforeSnapshot: JSON.stringify(before),
    afterSnapshot: JSON.stringify({ observationDate: updated.observationDate }),
  });

  return { actionId: action.id, findingStatus: "OPEN" as const, reversible: true, note: "日期已修正，重新体检后该问题会自动消解" };
}

async function syncObservedAt(findingId: string, ownerId: string, entityId: string | null) {
  if (!entityId) throw new ApiError(400, "ACTION_NOT_APPLICABLE", "该问题没有关联的观测记录");
  const observation = await prisma.observation.findFirst({ where: { id: entityId, ownerId } });
  if (!observation) throw new ApiError(404, "NOT_FOUND", "关联的观测记录已不存在");
  if (!isValidDateString(observation.observationDate)) {
    throw new ApiError(400, "ACTION_NOT_APPLICABLE", "日历日本身非法，请先用 FIX_DATE 修正");
  }

  const before = { id: observation.id, observedAt: observation.observedAt?.toISOString() ?? null };
  const next = dateStringToUtc(observation.observationDate);
  await prisma.observation.update({ where: { id: observation.id }, data: { observedAt: next } });

  const action = await recordAction({
    findingId,
    ownerId,
    action: "SYNC_OBSERVED_AT",
    params: JSON.stringify({ syncedTo: next.toISOString() }),
    beforeSnapshot: JSON.stringify(before),
    afterSnapshot: JSON.stringify({ observedAt: next.toISOString() }),
  });

  return { actionId: action.id, findingStatus: "OPEN" as const, reversible: true };
}

async function setPhenophase(findingId: string, ownerId: string, entityId: string | null, params: ApplyParams) {
  if (!entityId) throw new ApiError(400, "ACTION_NOT_APPLICABLE", "该问题没有关联的观测记录");
  if (!params.phenophaseId) throw new ApiError(400, "PHENOPHASE_REQUIRED", "请提供要补齐的物候阶段");

  const observation = await prisma.observation.findFirst({ where: { id: entityId, ownerId } });
  if (!observation) throw new ApiError(404, "NOT_FOUND", "关联的观测记录已不存在");

  const phase = await prisma.phenophase.findFirst({
    where: { id: params.phenophaseId, species: { ownerId } },
  });
  if (!phase) throw new ApiError(400, "PHENOPHASE_NOT_OWNED", "物候阶段不存在或不属于你");
  const speciesId = params.speciesId ?? observation.speciesId ?? phase.speciesId;
  if (phase.speciesId !== speciesId) throw new ApiError(400, "PHENOPHASE_MISMATCH", "物候阶段不属于所选物种");

  const before = { id: observation.id, speciesId: observation.speciesId, phenophaseId: observation.phenophaseId };
  await prisma.observation.update({
    where: { id: observation.id },
    data: { speciesId, phenophaseId: phase.id },
  });

  const action = await recordAction({
    findingId,
    ownerId,
    action: "SET_PHENOPHASE",
    params: JSON.stringify({ speciesId, phenophaseId: phase.id, reason: params.reason ?? null }),
    beforeSnapshot: JSON.stringify(before),
    afterSnapshot: JSON.stringify({ speciesId, phenophaseId: phase.id }),
  });

  return { actionId: action.id, findingStatus: "OPEN" as const, reversible: true };
}

async function quarantineFile(findingId: string, ownerId: string, finding: Prisma.QualityFindingGetPayload<{}>) {
  if (finding.ruleCode !== "FILE_ORPHAN" || !finding.storageKey) {
    throw new ApiError(400, "ACTION_NOT_APPLICABLE", "隔离动作只适用于孤立文件问题");
  }
  const key = finding.storageKey;

  // 先建动作凭据拿到 receiptId，文件被移动到以它命名的隔离目录，回滚不需要另找线索。
  const action = await recordAction({
    findingId,
    ownerId,
    action: "QUARANTINE_FILE",
    status: "APPLIED",
    params: JSON.stringify({ storageKey: key }),
    beforeSnapshot: JSON.stringify({ storageKey: key }),
  });

  const variants = ["thumb", "display", "original"] as const;
  const moved: Array<{ variant: (typeof variants)[number]; quarantinePath: string; bytes: number }> = [];
  try {
    for (const variant of variants) {
      try {
        const result = await storage.quarantine(key, variant, action.id);
        moved.push({ variant, ...result });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // 该变体本就缺失，无需隔离
        throw error;
      }
    }
  } catch (error) {
    // 半途中失败：尽量回滚已移动的文件，避免凭据与实际状态不一致。
    for (const item of moved) {
      await storage.restoreFromQuarantine(key, item.variant, action.id).catch(() => undefined);
    }
    throw error;
  }

  if (!moved.length) {
    // 文件已经不在了（可能被别的进程处理），核销动作并提示重新体检。
    await prisma.qualityAction.update({
      where: { id: action.id },
      data: { status: "VOIDED", afterSnapshot: JSON.stringify({ moved: [] }), rollbackResult: JSON.stringify({ reason: "NO_FILES" }) },
    });
    throw new ApiError(409, "FILE_ALREADY_GONE", "文件已不存在，请重新体检");
  }

  await prisma.qualityAction.update({
    where: { id: action.id },
    data: { afterSnapshot: JSON.stringify({ moved }) },
  });

  return {
    actionId: action.id,
    findingStatus: "OPEN" as const,
    reversible: true,
    quarantined: moved.map((item) => item.variant),
  };
}

async function dropPhotoRow(findingId: string, ownerId: string, finding: Prisma.QualityFindingGetPayload<{}>) {
  if (finding.ruleCode !== "FILE_MISSING" || !finding.entityId) {
    throw new ApiError(400, "ACTION_NOT_APPLICABLE", "删除照片行只适用于文件缺失问题");
  }
  const photo = await prisma.observationPhoto.findFirst({
    where: { id: finding.entityId, observation: { ownerId } },
  });
  if (!photo) throw new ApiError(404, "NOT_FOUND", "照片记录已不存在，可重新体检确认");

  // 整行 JSON 即回滚凭据：回滚时原样 create（含 id），照片关联的观测仍在。
  const before = JSON.parse(JSON.stringify(photo)) as Record<string, unknown>;
  await prisma.observationPhoto.delete({ where: { id: photo.id } });

  const action = await recordAction({
    findingId,
    ownerId,
    action: "DROP_PHOTO_ROW",
    params: JSON.stringify({ photoId: photo.id }),
    beforeSnapshot: JSON.stringify(before),
    afterSnapshot: JSON.stringify({ deleted: true }),
  });

  return { actionId: action.id, findingStatus: "OPEN" as const, reversible: true };
}

/**
 * 回滚一次处置动作。
 * - DISMISS → 问题回到 OPEN；
 * - FIX_DATE / SET_PHENOPHASE / SYNC_OBSERVED_AT → 用 beforeSnapshot 还原字段；
 * - QUARANTINE_FILE → 按 receiptId 从隔离目录移回原路径；
 * - DROP_PHOTO_ROW → 用快照重新插入照片行（若观测已被删除则返回明确错误，不静默成功）。
 * 已回滚的凭据不能再次回滚。
 */
export async function rollbackAction(ownerId: string, actionId: string) {
  const action = await prisma.qualityAction.findFirst({ where: { id: actionId, ownerId } });
  if (!action) throw new ApiError(404, "NOT_FOUND", "处置凭据不存在");
  if (action.rolledBackAt) throw new ApiError(409, "ALREADY_ROLLED_BACK", "该凭据已用于回滚");

  const before = JSON.parse(action.beforeSnapshot) as Record<string, unknown>;
  let result: Record<string, unknown> = {};

  switch (action.action) {
    case "DISMISS": {
      const finding = await prisma.qualityFinding.findFirst({ where: { id: action.findingId, ownerId } });
      if (finding?.status === "DISMISSED") {
        await prisma.qualityFinding.update({
          where: { id: finding.id },
          data: { status: "OPEN", dismissedAt: null },
        });
      }
      result = { findingStatus: "OPEN" };
      break;
    }

    case "FIX_DATE": {
      const targetId = before.id as string | undefined;
      if (!targetId) throw new ApiError(409, "ROLLBACK_TARGET_MISSING", "凭据中缺少观测记录定位信息");
      const existing = await prisma.observation.findUnique({ where: { id: targetId } });
      if (!existing) throw new ApiError(409, "ROLLBACK_TARGET_MISSING", "观测记录已被删除，无法回滚日期");
      await prisma.observation.update({
        where: { id: targetId },
        data: {
          observationDate: before.observationDate as string,
          observedAt: before.observedAt ? new Date(before.observedAt as string) : null,
        },
      });
      result = { restored: { observationDate: before.observationDate, observedAt: before.observedAt ?? null } };
      break;
    }

    case "SYNC_OBSERVED_AT": {
      const targetId = before.id as string | undefined;
      if (!targetId) throw new ApiError(409, "ROLLBACK_TARGET_MISSING", "凭据中缺少观测记录定位信息");
      const existing = await prisma.observation.findUnique({ where: { id: targetId } });
      if (!existing) throw new ApiError(409, "ROLLBACK_TARGET_MISSING", "观测记录已被删除，无法回滚时间戳");
      await prisma.observation.update({
        where: { id: targetId },
        data: { observedAt: before.observedAt ? new Date(before.observedAt as string) : null },
      });
      result = { restored: { observedAt: before.observedAt ?? null } };
      break;
    }

    case "SET_PHENOPHASE": {
      const targetId = before.id as string | undefined;
      if (!targetId) throw new ApiError(409, "ROLLBACK_TARGET_MISSING", "凭据中缺少观测记录定位信息");
      const existing = await prisma.observation.findUnique({ where: { id: targetId } });
      if (!existing) throw new ApiError(409, "ROLLBACK_TARGET_MISSING", "观测记录已被删除，无法回滚阶段");
      await prisma.observation.update({
        where: { id: targetId },
        data: {
          speciesId: (before.speciesId as string | null) ?? null,
          phenophaseId: (before.phenophaseId as string | null) ?? null,
        },
      });
      result = { restored: { speciesId: before.speciesId ?? null, phenophaseId: before.phenophaseId ?? null } };
      break;
    }

    case "QUARANTINE_FILE": {
      const key = before.storageKey as string;
      const after = action.afterSnapshot ? (JSON.parse(action.afterSnapshot) as { moved?: Array<{ variant: "thumb" | "display" | "original" }> }) : {};
      const variants = (after.moved ?? []).map((item) => item.variant);
      const restored: Array<{ variant: string; bytes: number }> = [];
      for (const variant of variants) {
        restored.push({ variant, ...(await storage.restoreFromQuarantine(key, variant, action.id)) });
      }
      result = { restored };
      break;
    }

    case "DROP_PHOTO_ROW": {
      const data = before as Prisma.ObservationPhotoUncheckedCreateInput;
      const observation = await prisma.observation.findUnique({ where: { id: data.observationId } });
      if (!observation) {
        throw new ApiError(409, "ROLLBACK_TARGET_MISSING", "照片所属观测已被删除，需先恢复观测后再回滚（照片行快照已保留在凭据中）");
      }
      await prisma.observationPhoto.create({ data });
      result = { reinsertedPhotoId: data.id };
      break;
    }

    default:
      throw new ApiError(400, "UNSUPPORTED_ACTION", `未知动作类型：${action.action}`);
  }

  await prisma.qualityAction.update({
    where: { id: action.id },
    data: { status: "ROLLED_BACK", rolledBackAt: new Date(), rollbackResult: JSON.stringify(result) },
  });

  return { actionId: action.id, action: action.action, result };
}
