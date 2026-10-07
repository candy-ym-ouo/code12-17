import crypto from "node:crypto";
import { isValidDateString, parseDateString } from "../../lib/date";

/**
 * 数据质量体检规则集（ruleset 版本：1.0.0）。
 *
 * 设计约束：
 *  - 所有规则都是纯函数式判定，输入同一份数据必然得到同一份结论 → 分级建议可复算；
 *  - 每条问题有稳定 fingerprint（owner + 规则 + 实体定位），跨多次扫描可去重复用；
 *  - 只负责"发现问题并给出建议动作"，不直接修改数据，处置逻辑在 actions.ts。
 */

export const RULESET_VERSION = "1.0.0";

export type FindingSeverity = "CRITICAL" | "WARNING" | "INFO";
export type FindingCategory = "DATE" | "PHASE" | "FILE";

/** 建议动作枚举，同时作为路由/处置层的白名单。 */
export const SUGGESTED_ACTIONS = [
  "FIX_DATE", // 用日期字段修正 observedAt（或用 observedAt 回填 observationDate）
  "SET_PHENOPHASE", // 人工补齐物候阶段
  "QUARANTINE_FILE", // 把孤立文件移入隔离区（可逆）
  "DROP_PHOTO_ROW", // 物理文件全部缺失时删除照片元数据行（可逆，回滚即重新插入）
  "MANUAL_REVIEW", // 只能人工核查后忽略
  "DISMISS", // 已知问题，确认忽略
] as const;

export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

export interface ObservationRow {
  id: string;
  kind: string;
  status: string;
  observationDate: string;
  observedAt: Date | null;
  speciesId: string | null;
  phenophaseId: string | null;
  title: string | null;
  siteName: string | null;
  photoCount: number;
}

export interface PhotoRow {
  id: string;
  observationId: string;
  storageKey: string;
  thumbKey: string;
  displayKey: string;
  originalName: string;
}

export interface StoredFile {
  key: string;
  variant: "thumb" | "display" | "original";
  bytes: number;
}

export interface ScanInput {
  observations: ObservationRow[];
  photos: PhotoRow[];
  files: StoredFile[]; // 三个变体目录的并集
  /** 是否启用需要全盘文件清单的规则（孤立文件归属无法按用户切分时，仅管理员/CLI 使用）。 */
  includeOrphanFiles: boolean;
  /** 日期合法窗口，超出视为越界。 */
  minYear: number;
  maxYear: number;
}

export interface FindingDraft {
  ruleCode: string;
  category: FindingCategory;
  severity: FindingSeverity;
  entityType: "OBSERVATION" | "PHOTO" | "STORAGE_KEY";
  entityId: string | null;
  storageKey: string | null;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  suggestion: string;
  suggestedAction: SuggestedAction;
  fingerprint: string;
}

export interface ScanSummary {
  total: number;
  bySeverity: { CRITICAL: number; WARNING: number; INFO: number };
  byCategory: { DATE: number; PHASE: number; FILE: number };
  byRule: Record<string, number>;
  observationsScanned: number;
  photosScanned: number;
  filesScanned: number;
}

export interface ScanResult {
  findings: FindingDraft[];
  summary: ScanSummary;
}

/** fingerprint 必须跨扫描稳定：同一用户 + 同一规则 + 同一实体定位。 */
function fingerprint(ownerId: string, parts: Array<string | null>): string {
  return crypto
    .createHash("sha256")
    .update([ownerId, ...parts.map((part) => part ?? "∅")].join("|"))
    .digest("hex");
}

function observedAtDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function emptySummary(observations: number, photos: number, files: number): ScanSummary {
  return {
    total: 0,
    bySeverity: { CRITICAL: 0, WARNING: 0, INFO: 0 },
    byCategory: { DATE: 0, PHASE: 0, FILE: 0 },
    byRule: {},
    observationsScanned: observations,
    photosScanned: photos,
    filesScanned: files,
  };
}

/**
 * 执行规则集。ownerId 参与 fingerprint 计算。
 */
export function runRuleset(ownerId: string, input: ScanInput): ScanResult {
  const findings: FindingDraft[] = [];
  const summary = emptySummary(input.observations.length, input.photos.length, input.files.length);

  const add = (draft: FindingDraft): void => {
    findings.push(draft);
    summary.total += 1;
    summary.bySeverity[draft.severity] += 1;
    summary.byCategory[draft.category] += 1;
    summary.byRule[draft.ruleCode] = (summary.byRule[draft.ruleCode] ?? 0) + 1;
  };

  // ---- 一、日期越界 -------------------------------------------------------

  for (const row of input.observations) {
    const parsed = parseDateString(row.observationDate);

    if (!isValidDateString(row.observationDate) || !parsed) {
      add({
        ruleCode: "DATE_INVALID",
        category: "DATE",
        severity: "CRITICAL",
        entityType: "OBSERVATION",
        entityId: row.id,
        storageKey: null,
        title: "观测日期无法解析",
        detail: `观测记录「${row.title ?? row.id}」的日期 "${row.observationDate}" 不是合法的 YYYY-MM-DD 日历日，时间线分组与统计都会跳过它。`,
        evidence: { observationId: row.id, observationDate: row.observationDate },
        suggestion:
          row.observedAt != null
            ? `可直接采用 observedAt 对应的当地日期 ${observedAtDay(row.observedAt)} 回填，或人工指定正确日期。`
            : "该记录没有可兜底的 observedAt，需要人工指定正确日期。",
        suggestedAction: "FIX_DATE",
        fingerprint: fingerprint(ownerId, ["DATE_INVALID", "OBSERVATION", row.id]),
      });
      continue
    }

    if (parsed.year < input.minYear || parsed.year > input.maxYear) {
      add({
        ruleCode: "DATE_OUT_OF_RANGE",
        category: "DATE",
        severity: "WARNING",
        entityType: "OBSERVATION",
        entityId: row.id,
        storageKey: null,
        title: "观测日期超出合理窗口",
        detail: `观测记录「${row.title ?? row.id}」日期为 ${row.observationDate}，超出配置的合理区间 ${input.minYear}–${input.maxYear}，常见于年份误录（如把 2025 写成 2052）。`,
        evidence: {
          observationId: row.id,
          observationDate: row.observationDate,
          minYear: input.minYear,
          maxYear: input.maxYear,
        },
        suggestion: row.observedAt != null
          ? `observedAt 指向 ${observedAtDay(row.observedAt)}，若可信可一键回填；否则请人工修正年份。`
          : "请人工核对并修正年份。",
        suggestedAction: "FIX_DATE",
        fingerprint: fingerprint(ownerId, ["DATE_OUT_OF_RANGE", "OBSERVATION", row.id]),
      });
    }

    if (row.observedAt != null) {
      const atDay = observedAtDay(row.observedAt);
      if (atDay !== row.observationDate) {
        add({
          ruleCode: "DATE_OBSERVED_AT_MISMATCH",
          category: "DATE",
          severity: "INFO",
          entityType: "OBSERVATION",
          entityId: row.id,
          storageKey: null,
          title: "日期字段与时间戳不一致",
          detail: `观测记录「${row.title ?? row.id}」的当地日历日为 ${row.observationDate}，但 observedAt 落在 ${atDay}。统计以日历日为准，时间戳漂移不影响分组，但说明历史导入或时区处理有瑕疵。`,
          evidence: {
            observationId: row.id,
            observationDate: row.observationDate,
            observedAt: row.observedAt.toISOString(),
            observedAtDay: atDay,
          },
          suggestion: `可把 observedAt 同步为 ${row.observationDate} 的 UTC 零点（仅影响精度补充字段）。`,
          suggestedAction: "FIX_DATE",
          fingerprint: fingerprint(ownerId, ["DATE_OBSERVED_AT_MISMATCH", "OBSERVATION", row.id]),
        });
      }
    }
  }

  // ---- 二、阶段缺失 -------------------------------------------------------

  for (const row of input.observations) {
    if (row.kind === "PLANT_PHENOLOGY" && !row.phenophaseId) {
      add({
        ruleCode: "PHASE_MISSING_FOR_PLANT",
        category: "PHASE",
        severity: "WARNING",
        entityType: "OBSERVATION",
        entityId: row.id,
        storageKey: null,
        title: "植物物候记录缺少阶段",
        detail: `记录「${row.title ?? row.id}」（${row.siteName ?? "未知地点"}，${row.observationDate}）是植物物候观测但没有选择物候阶段，无法参与首现日对比。`,
        evidence: {
          observationId: row.id,
          kind: row.kind,
          speciesId: row.speciesId,
          observationDate: row.observationDate,
        },
        suggestion: row.speciesId
          ? "请在编辑页为该记录补选所属物种的物候阶段。"
          : "该记录同时缺少物种，需要先补物种再补阶段。",
        suggestedAction: "SET_PHENOPHASE",
        fingerprint: fingerprint(ownerId, ["PHASE_MISSING_FOR_PLANT", "OBSERVATION", row.id]),
      });
    }

    if (row.phenophaseId && !row.speciesId) {
      add({
        ruleCode: "PHASE_WITHOUT_SPECIES",
        category: "PHASE",
        severity: "WARNING",
        entityType: "OBSERVATION",
        entityId: row.id,
        storageKey: null,
        title: "存在物候阶段但缺少物种",
        detail: `记录「${row.title ?? row.id}」挂了物候阶段却没有物种，阶段归属无法解释（正常情况下删除物种会被置空，出现该状态说明历史数据被直接改过库）。`,
        evidence: { observationId: row.id, phenophaseId: row.phenophaseId },
        suggestion: "请在编辑页补选物种与对应阶段，或清空阶段。",
        suggestedAction: "MANUAL_REVIEW",
        fingerprint: fingerprint(ownerId, ["PHASE_WITHOUT_SPECIES", "OBSERVATION", row.id]),
      });
    }
  }

  // ---- 三、孤立文件 -------------------------------------------------------
  // 两个方向：
  //  3a. 数据库里有照片行，但三个变体中任一物理文件缺失 → FILE_MISSING（按照片行归属用户）
  //  3b. 磁盘上存在文件，但没有任何照片行引用该 key → FILE_ORPHAN（需全盘清单）

  const referencedKeys = new Map<string, PhotoRow>();
  for (const photo of input.photos) {
    referencedKeys.set(photo.storageKey, photo);
    referencedKeys.set(photo.thumbKey, photo);
    referencedKeys.set(photo.displayKey, photo);
  }

  const presentKeysByVariant: Record<"thumb" | "display" | "original", Set<string>> = {
    thumb: new Set(),
    display: new Set(),
    original: new Set(),
  };
  for (const file of input.files) presentKeysByVariant[file.variant].add(file.key);

  // 每张照片一行发现，variants 中记录具体缺失的变体。
  type PhotoGroup = { photo: PhotoRow; missing: Array<"thumb" | "display" | "original"> };
  const missingGroups: PhotoGroup[] = [];
  for (const photo of input.photos) {
    const missing: Array<"thumb" | "display" | "original"> = [];
    if (!presentKeysByVariant.thumb.has(photo.thumbKey)) missing.push("thumb");
    if (!presentKeysByVariant.display.has(photo.displayKey)) missing.push("display");
    if (!presentKeysByVariant.original.has(photo.storageKey)) missing.push("original");
    if (missing.length) missingGroups.push({ photo, missing });
  }

  for (const group of missingGroups) {
    const allMissing = group.missing.length === 3;
    add({
      ruleCode: "FILE_MISSING",
      category: "FILE",
      // 三档全丢会直接导致图片 404，定为严重；只缺部分（原图缺失、缩略图还在）定为警告。
      severity: allMissing ? "CRITICAL" : "WARNING",
      entityType: "PHOTO",
      entityId: group.photo.id,
      storageKey: group.photo.storageKey,
      title: allMissing ? "照片物理文件全部缺失" : "照片部分变体缺失",
      detail: `观测 ${group.photo.observationId} 的照片「${group.photo.originalName}」在磁盘上缺少 ${group.missing.join("、")} 变体，前端对应档位会加载失败。`,
      evidence: {
        photoId: group.photo.id,
        observationId: group.photo.observationId,
        storageKey: group.photo.storageKey,
        thumbKey: group.photo.thumbKey,
        displayKey: group.photo.displayKey,
        missingVariants: group.missing,
      },
      suggestion: allMissing
        ? "三档文件均已丢失，无法恢复图片本身；可删除这条照片元数据（记录会保留，仅移除坏图引用，操作可回滚）。"
        : "缩略图/展示图仍可服务；若确认原图无法找回，可忽略此问题。",
      suggestedAction: allMissing ? "DROP_PHOTO_ROW" : "DISMISS",
      fingerprint: fingerprint(ownerId, ["FILE_MISSING", "PHOTO", group.photo.id]),
    });
  }

  if (input.includeOrphanFiles) {
    // 以 key 聚合磁盘文件；任一变体存在且无任何照片行引用，即视为孤立文件组。
    const keysOnDisk = new Set(input.files.map((file) => file.key));
    const photoByReferencedKey = new Map<string, PhotoRow>();
    for (const photo of input.photos) {
      photoByReferencedKey.set(photo.storageKey, photo);
      photoByReferencedKey.set(photo.thumbKey, photo);
      photoByReferencedKey.set(photo.displayKey, photo);
    }

    for (const key of [...keysOnDisk].sort()) {
      if (referencedKeys.has(key)) continue;
      const variants = (["thumb", "display", "original"] as const).filter((variant) =>
        presentKeysByVariant[variant].has(key),
      );
      const bytes = input.files.filter((file) => file.key === key).reduce((sum, file) => sum + file.bytes, 0);
      add({
        ruleCode: "FILE_ORPHAN",
        category: "FILE",
        // 三档齐全的典型"上传中断/删除残留"垃圾占空间，警告；只有单档残留定为提示。
        severity: variants.length === 3 ? "WARNING" : "INFO",
        entityType: "STORAGE_KEY",
        entityId: null,
        storageKey: key,
        title: "磁盘存在未被任何记录引用的孤立文件",
        detail: `存储 key ${key} 在 ${variants.join("、")} 目录下存在文件（共 ${bytes} 字节），但数据库没有对应照片记录，通常来自上传中断或删除观测后的文件残留。`,
        evidence: { storageKey: key, variants, bytes },
        suggestion: "可将该 key 的现存变体移入隔离区（不硬删除），确认无影响后再清理；误隔离可凭动作凭据一键还原。",
        suggestedAction: "QUARANTINE_FILE",
        fingerprint: fingerprint(ownerId, ["FILE_ORPHAN", "STORAGE_KEY", key]),
      });
    }
  }

  return { findings, summary };
}

/**
 * 单条问题分级的离线复算：给定证据快照与输入参数，重新判定严重级别与建议动作。
 * 用于：1) 重新扫描后更新旧问题分级；2) GET 接口向调用方证明分级不是拍脑袋的。
 * 返回 null 表示该问题在当前数据上已不复存在（应由扫描器置为 RESOLVED）。
 */
export function reclassifyFinding(
  draft: Pick<FindingDraft, "ruleCode" | "evidence">,
  context: { minYear: number; maxYear: number },
): { severity: FindingSeverity; suggestedAction: SuggestedAction } | null {
  const evidence = draft.evidence as Record<string, unknown>;
  switch (draft.ruleCode) {
    case "DATE_INVALID":
      return { severity: "CRITICAL", suggestedAction: "FIX_DATE" };
    case "DATE_OUT_OF_RANGE": {
      const date = String(evidence.observationDate ?? "");
      const year = Number(date.slice(0, 4));
      if (Number.isFinite(year) && year >= context.minYear && year <= context.maxYear) return null;
      return { severity: "WARNING", suggestedAction: "FIX_DATE" };
    }
    case "DATE_OBSERVED_AT_MISMATCH":
      if (evidence.observationDate === evidence.observedAtDay) return null;
      return { severity: "INFO", suggestedAction: "FIX_DATE" };
    case "PHASE_MISSING_FOR_PLANT":
    case "PHASE_WITHOUT_SPECIES":
      return {
        severity: "WARNING",
        suggestedAction: draft.ruleCode === "PHASE_MISSING_FOR_PLANT" ? "SET_PHENOPHASE" : "MANUAL_REVIEW",
      };
    case "FILE_MISSING": {
      const missing = Array.isArray(evidence.missingVariants) ? evidence.missingVariants : [];
      return {
        severity: missing.length === 3 ? "CRITICAL" : "WARNING",
        suggestedAction: missing.length === 3 ? "DROP_PHOTO_ROW" : "DISMISS",
      };
    }
    case "FILE_ORPHAN": {
      const variants = Array.isArray(evidence.variants) ? evidence.variants : [];
      return { severity: variants.length === 3 ? "WARNING" : "INFO", suggestedAction: "QUARANTINE_FILE" };
    }
    default:
      return null;
  }
}
