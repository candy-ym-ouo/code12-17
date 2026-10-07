import crypto from "node:crypto";
import { daysBetween, parseDateString } from "../../lib/date";

/**
 * 数据质量体检规则引擎。
 *
 * 可复算约定：本文件只包含纯函数。同一份数据快照 + 同一个参照日 + 同一个
 * RULESET_VERSION，必然产出完全一致的发现列表（指纹、级别、排序均确定），
 * 因此体检报告可以反复重算并互相核对（digest 相同即结论相同）。
 */
export const RULESET_VERSION = "1.0.0";

export const FINDING_CATEGORIES = ["DATE_OUT_OF_RANGE", "MISSING_STAGE", "ORPHAN_FILE"] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const SEVERITIES = ["CRITICAL", "WARNING", "INFO"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ACTION_KINDS = ["quarantine_files", "clear_phenophase", "drop_photo_record"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type EntityType = "observation" | "species" | "photo" | "file";

export interface RuleMeta {
  id: string;
  category: FindingCategory;
  /** 基准级别；个别规则会按数据确定性地上调/下调（见各 evaluate 函数注释）。 */
  severity: Severity;
  title: string;
  suggestion: string;
  /** 该规则产出的发现可执行的处置动作（仅当发现本身可处置时才带到发现上）。 */
  action?: ActionKind;
}

export const RULES: RuleMeta[] = [
  {
    id: "date.invalid",
    category: "DATE_OUT_OF_RANGE",
    severity: "CRITICAL",
    title: "观测日期非法",
    suggestion: "日期无法按 YYYY-MM-DD 解析，该记录不会参与任何统计与导出，请直接改库修正或删除。",
  },
  {
    id: "date.future",
    category: "DATE_OUT_OF_RANGE",
    severity: "WARNING",
    title: "观测日期晚于参照日",
    suggestion: "核对是否误填年份（例如 2026 写成 2062），修正后重新体检确认。",
  },
  {
    id: "date.too-old",
    category: "DATE_OUT_OF_RANGE",
    severity: "WARNING",
    title: "观测日期早于 1900 年",
    suggestion: "确认是否为历史资料补录；如为误填请修正年份。",
  },
  {
    id: "date.before-site",
    category: "DATE_OUT_OF_RANGE",
    severity: "INFO",
    title: "观测日期早于地点创建时间",
    suggestion: "补录历史数据属正常情况；若非补录，请检查日期或地点。",
  },
  {
    id: "date.observed-at-gap",
    category: "DATE_OUT_OF_RANGE",
    severity: "INFO",
    title: "记录时间与观测日期偏差过大",
    suggestion: "observedAt 与 observationDate 的日历日相差超过 1 天（超过 366 天升级为 WARNING），核对该记录。",
  },
  {
    id: "stage.missing",
    category: "MISSING_STAGE",
    severity: "WARNING",
    title: "物候类记录缺少阶段",
    suggestion: "为该记录补选物候阶段，否则无法参与首现日对比与统计。",
  },
  {
    id: "stage.mismatch",
    category: "MISSING_STAGE",
    severity: "CRITICAL",
    title: "物候阶段与物种不匹配",
    suggestion: "阶段不属于该观测的物种（多由迁移或导入造成），可一键清空阶段后重新选择。",
    action: "clear_phenophase",
  },
  {
    id: "stage.species-no-phases",
    category: "MISSING_STAGE",
    severity: "INFO",
    title: "物种未配置任何物候阶段",
    suggestion: "在物种页为该物种添加阶段，或从预置库重新导入阶段定义。",
  },
  {
    id: "file.orphan",
    category: "ORPHAN_FILE",
    severity: "WARNING",
    title: "磁盘文件无任何记录引用",
    suggestion: "通常是删除记录时的残留或上传中断产物，可隔离到 .quality 目录（保留回滚凭据）。",
    action: "quarantine_files",
  },
  {
    id: "file.missing",
    category: "ORPHAN_FILE",
    severity: "CRITICAL",
    title: "照片记录缺少磁盘文件",
    suggestion: "文件已丢失：优先从备份恢复；若全部变体均缺失，可移除该照片记录（凭据可回滚）。",
    action: "drop_photo_record",
  },
];

const RULE_INDEX = new Map(RULES.map((rule) => [rule.id, rule]));

export interface Finding {
  fingerprint: string;
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  message: string;
  entity: { type: EntityType; id: string };
  details: Record<string, unknown>;
  action?: ActionKind;
}

/** 观测快照：日期字段已换算成用户时区的日历日字符串，规则层不再碰 Date 对象。 */
export interface ObservationSnapshot {
  id: string;
  kind: string;
  status: string;
  observationDate: string;
  /** observedAt 在用户时区的日历日；无 observedAt 时为 null。 */
  observedAtDate: string | null;
  siteId: string;
  /** 地点创建时间在用户时区的日历日。 */
  siteCreatedDate: string;
  speciesId: string | null;
  phenophaseId: string | null;
  /** 当前阶段所属物种；未设阶段时为 null。 */
  phenophaseSpeciesId: string | null;
  /** 该观测物种已配置的阶段数；无物种时为 null。 */
  speciesPhenophaseCount: number | null;
}

export interface SpeciesSnapshot {
  id: string;
  commonName: string;
  phenophaseCount: number;
  archived: boolean;
}

export interface PhotoSnapshot {
  id: string;
  observationId: string;
  storageKey: string;
  thumbKey: string;
  displayKey: string;
}

export interface FileSnapshot {
  variant: "thumb" | "display" | "original";
  key: string;
}

export interface QualitySnapshot {
  observations: ObservationSnapshot[];
  species: SpeciesSnapshot[];
  /** 当前用户的照片记录（用于缺失文件检测）。 */
  photos: PhotoSnapshot[];
  /** 全库所有照片记录引用过的 key（用于孤儿判定，避免误伤其他用户的文件）。 */
  knownKeys: Set<string>;
  /** 磁盘上实际存在的文件。 */
  diskFiles: FileSnapshot[];
}

const STAGE_KINDS = new Set(["PLANT_PHENOLOGY", "INSECT_SIGHTING", "BIRD_SOUND"]);
const MIN_REASONABLE_YEAR = 1900;
const GAP_INFO_DAYS = 1;
const GAP_WARNING_DAYS = 366;

function fingerprint(ruleId: string, entityType: EntityType, entityId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${RULESET_VERSION}|${ruleId}|${entityType}|${entityId}`)
    .digest("hex")
    .slice(0, 16);
}

function makeFinding(
  ruleId: string,
  entityType: EntityType,
  entityId: string,
  message: string,
  details: Record<string, unknown>,
  overrides: { severity?: Severity; action?: ActionKind | null } = {},
): Finding {
  const rule = RULE_INDEX.get(ruleId);
  if (!rule) throw new Error(`未注册的规则：${ruleId}`);
  // overrides.action 传 null 表示显式抑制该发现的处置动作
  const action = overrides.action === null ? undefined : (overrides.action ?? rule.action);
  return {
    fingerprint: fingerprint(ruleId, entityType, entityId),
    ruleId,
    category: rule.category,
    severity: overrides.severity ?? rule.severity,
    title: rule.title,
    message,
    entity: { type: entityType, id: entityId },
    details,
    ...(action ? { action } : {}),
  };
}

export function evaluateDates(observations: ObservationSnapshot[], referenceDate: string): Finding[] {
  const findings: Finding[] = [];
  for (const obs of observations) {
    const parsed = parseDateString(obs.observationDate);
    if (!parsed) {
      findings.push(
        makeFinding("date.invalid", "observation", obs.id, `观测日期「${obs.observationDate}」不是合法的 YYYY-MM-DD 日期`, {
          observationDate: obs.observationDate,
        }),
      );
      continue; // 日期不可解析时，其余日期规则无从谈起
    }
    if (obs.observationDate > referenceDate) {
      findings.push(
        makeFinding("date.future", "observation", obs.id, `观测日期 ${obs.observationDate} 晚于参照日 ${referenceDate}`, {
          observationDate: obs.observationDate,
          referenceDate,
        }),
      );
    }
    if (parsed.year < MIN_REASONABLE_YEAR) {
      findings.push(
        makeFinding("date.too-old", "observation", obs.id, `观测日期 ${obs.observationDate} 早于 ${MIN_REASONABLE_YEAR} 年`, {
          observationDate: obs.observationDate,
        }),
      );
    }
    if (obs.observationDate < obs.siteCreatedDate) {
      findings.push(
        makeFinding(
          "date.before-site",
          "observation",
          obs.id,
          `观测日期 ${obs.observationDate} 早于地点创建日 ${obs.siteCreatedDate}`,
          { observationDate: obs.observationDate, siteCreatedDate: obs.siteCreatedDate, siteId: obs.siteId },
        ),
      );
    }
    if (obs.observedAtDate) {
      const gap = Math.abs(daysBetween(obs.observationDate, obs.observedAtDate));
      if (gap > GAP_INFO_DAYS) {
        findings.push(
          makeFinding(
            "date.observed-at-gap",
            "observation",
            obs.id,
            `记录时间与观测日期相差 ${gap} 天`,
            { observationDate: obs.observationDate, observedAtDate: obs.observedAtDate, gapDays: gap },
            { severity: gap > GAP_WARNING_DAYS ? "WARNING" : "INFO" },
          ),
        );
      }
    }
  }
  return findings;
}

export function evaluateStages(observations: ObservationSnapshot[], species: SpeciesSnapshot[]): Finding[] {
  const findings: Finding[] = [];
  for (const obs of observations) {
    if (obs.phenophaseId && obs.phenophaseSpeciesId && obs.phenophaseSpeciesId !== obs.speciesId) {
      findings.push(
        makeFinding(
          "stage.mismatch",
          "observation",
          obs.id,
          "物候阶段不属于该观测的物种",
          { phenophaseId: obs.phenophaseId, phenophaseSpeciesId: obs.phenophaseSpeciesId, speciesId: obs.speciesId },
        ),
      );
    }
    // 草稿允许缺阶段（尚未填写完），只检查已发布记录
    if (
      obs.status === "PUBLISHED" &&
      STAGE_KINDS.has(obs.kind) &&
      obs.speciesId &&
      !obs.phenophaseId &&
      (obs.speciesPhenophaseCount ?? 0) > 0
    ) {
      findings.push(
        makeFinding("stage.missing", "observation", obs.id, "物候类观测已发布但未填写阶段", {
          kind: obs.kind,
          speciesId: obs.speciesId,
        }),
      );
    }
  }
  for (const item of species) {
    if (!item.archived && item.phenophaseCount === 0) {
      findings.push(
        makeFinding("stage.species-no-phases", "species", item.id, `物种「${item.commonName}」未配置任何物候阶段`, {
          commonName: item.commonName,
        }),
      );
    }
  }
  return findings;
}

export function evaluateFiles(snapshot: QualitySnapshot): Finding[] {
  const findings: Finding[] = [];
  const onDisk = new Set(snapshot.diskFiles.map((file) => `${file.variant}/${file.key}`));

  for (const file of snapshot.diskFiles) {
    if (!snapshot.knownKeys.has(file.key)) {
      findings.push(
        makeFinding("file.orphan", "file", `${file.variant}/${file.key}`, `磁盘文件 ${file.variant}/${file.key} 没有任何照片记录引用`, {
          variant: file.variant,
          key: file.key,
        }),
      );
    }
  }

  for (const photo of snapshot.photos) {
    const variants: Array<[FileSnapshot["variant"], string]> = [
      ["thumb", photo.thumbKey],
      ["display", photo.displayKey],
      ["original", photo.storageKey],
    ];
    const missing = variants.filter(([variant, key]) => !onDisk.has(`${variant}/${key}`)).map(([variant]) => variant);
    if (missing.length === 0) continue;
    const allMissing = missing.length === variants.length;
    findings.push(
      makeFinding(
        "file.missing",
        "photo",
        photo.id,
        allMissing ? "照片的全部文件均已丢失" : `照片缺少 ${missing.join("、")} 文件`,
        { observationId: photo.observationId, missingVariants: missing },
        // 全部丢失才可安全移除记录；部分缺失需要人工判断（可能可重新生成）
        allMissing ? {} : { severity: "WARNING", action: null },
      ),
    );
  }
  return findings;
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      a.ruleId.localeCompare(b.ruleId) ||
      a.entity.type.localeCompare(b.entity.type) ||
      a.entity.id.localeCompare(b.entity.id),
  );
}

export function evaluateSnapshot(snapshot: QualitySnapshot, referenceDate: string): Finding[] {
  return sortFindings([
    ...evaluateDates(snapshot.observations, referenceDate),
    ...evaluateStages(snapshot.observations, snapshot.species),
    ...evaluateFiles(snapshot),
  ]);
}

/** 报告摘要指纹：同一批发现的判定结论一致时 digest 必然一致。 */
export function digestFindings(findings: Finding[]): string {
  const material = findings
    .map((finding) => `${finding.fingerprint}:${finding.severity}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(material).digest("hex");
}
