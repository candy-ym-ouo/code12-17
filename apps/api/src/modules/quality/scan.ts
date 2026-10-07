import { currentYearInTimezone } from "../../lib/date";
import { prisma } from "../../lib/prisma";
import { storage } from "../../lib/storage";
import {
  RULESET_VERSION,
  reclassifyFinding,
  runRuleset,
  type FindingDraft,
  type FindingSeverity,
  type ScanResult,
} from "./rules";

export interface ScanOptions {
  /** 传入事务客户端时，整次扫描与记账在同一事务内（CLI/动作回滚不需要）。 */
  minYear?: number;
  maxYear?: number;
  /** 是否扫描孤立磁盘文件。该规则需要全盘文件清单，只能由管理员或 CLI 触发。 */
  includeOrphanFiles: boolean;
  /** 规则只扫某类问题，缺省为全部。 */
  categories?: Array<"DATE" | "PHASE" | "FILE">;
}

const DEFAULT_MIN_YEAR = 1990;

/** 收集一个用户的数据并执行规则集，不做任何写库。 */
export async function collectAndScan(
  ownerId: string,
  options: ScanOptions,
): Promise<ScanResult> {
  const minYear = options.minYear ?? DEFAULT_MIN_YEAR;
  const maxYear = options.maxYear ?? currentYearInTimezone("Asia/Shanghai") + 1;

  const rows = await prisma.observation.findMany({
    where: { ownerId },
    select: {
      id: true,
      kind: true,
      status: true,
      observationDate: true,
      observedAt: true,
      speciesId: true,
      phenophaseId: true,
      title: true,
      site: { select: { name: true } },
      _count: { select: { photos: true } },
    },
  });

  const photos = await prisma.observationPhoto.findMany({
    where: { observation: { ownerId } },
    select: {
      id: true,
      observationId: true,
      storageKey: true,
      thumbKey: true,
      displayKey: true,
      originalName: true,
    },
  });

  // FILE_MISSING 只需判定"在不在"，includeOrphanFiles=false 时仍需枚举磁盘，
  // 但只关心该用户照片引用到的 key；storage.list 按变体返回全盘清单，成本可接受。
  const variants = ["thumb", "display", "original"] as const;
  const filesByVariant = await Promise.all(variants.map((variant) => storage.list(variant)));
  const allFiles = filesByVariant.flat();

  let result = runRuleset(ownerId, {
    observations: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      observationDate: row.observationDate,
      observedAt: row.observedAt,
      speciesId: row.speciesId,
      phenophaseId: row.phenophaseId,
      title: row.title,
      siteName: row.site.name,
      photoCount: row._count.photos,
    })),
    photos,
    files: allFiles,
    includeOrphanFiles: options.includeOrphanFiles,
    minYear,
    maxYear,
  });

  if (options.categories && options.categories.length < 3) {
    const allow = new Set(options.categories);
    result = {
      findings: result.findings.filter((finding) => allow.has(finding.category)),
      summary: result.summary, // summary 仅描述全量扫描成本，过滤后数字在 buildSummary 时重算
    };
  }

  return result;
}

function recomputeSummary(findings: FindingDraft[], base: ScanResult["summary"]): ScanResult["summary"] {
  const summary: ScanResult["summary"] = {
    total: findings.length,
    bySeverity: { CRITICAL: 0, WARNING: 0, INFO: 0 },
    byCategory: { DATE: 0, PHASE: 0, FILE: 0 },
    byRule: {},
    observationsScanned: base.observationsScanned,
    photosScanned: base.photosScanned,
    filesScanned: base.filesScanned,
  };
  for (const finding of findings) {
    summary.bySeverity[finding.severity] += 1;
    summary.byCategory[finding.category] += 1;
    summary.byRule[finding.ruleCode] = (summary.byRule[finding.ruleCode] ?? 0) + 1;
  }
  return summary;
}

/**
 * 执行一次体检：扫描 → 创建报告 → 对账历史问题（fingerprint 去重、可复算分级）。
 *
 * 对账语义：
 *  - 新问题：插入 OPEN；
 *  - 已存在且仍命中：刷新分级/建议/证据，保持 OPEN（DISMISSED 是人工决定，不自动复活）；
 *  - 已存在但本次未命中：OPEN → RESOLVED；
 *  - DISMISSED 不动；FIXED/已回滚回 OPEN 的问题按 OPEN 处理。
 */
export async function runScan(ownerId: string, options: ScanOptions) {
  const scanned = await collectAndScan(ownerId, options);
  const summary = recomputeSummary(scanned.findings, scanned.summary);
  const params = {
    minYear: options.minYear ?? DEFAULT_MIN_YEAR,
    maxYear: options.maxYear ?? currentYearInTimezone("Asia/Shanghai") + 1,
    includeOrphanFiles: options.includeOrphanFiles,
    categories: options.categories ?? ["DATE", "PHASE", "FILE"],
  };

  return prisma.$transaction(async (tx) => {
    const report = await tx.qualityReport.create({
      data: {
        ownerId,
        rulesetVersion: RULESET_VERSION,
        status: "COMPLETED",
        summary: JSON.stringify(summary),
        params: JSON.stringify(params),
        completedAt: new Date(),
      },
    });

    const categoryFilter = new Set(options.categories ?? ["DATE", "PHASE", "FILE"]);
    const existing = await tx.qualityFinding.findMany({
      where: { ownerId, category: { in: [...categoryFilter] } },
      select: {
        id: true,
        fingerprint: true,
        ruleCode: true,
        status: true,
        evidence: true,
      },
    });
    const existingByFp = new Map(existing.map((finding) => [finding.fingerprint, finding]));
    const touchedFps = new Set<string>();

    for (const draft of scanned.findings) {
      touchedFps.add(draft.fingerprint);
      const prev = existingByFp.get(draft.fingerprint);
      if (!prev) {
        await tx.qualityFinding.create({
          data: {
            ownerId,
            reportId: report.id,
            ruleCode: draft.ruleCode,
            category: draft.category,
            severity: draft.severity,
            status: "OPEN",
            entityType: draft.entityType,
            entityId: draft.entityId,
            storageKey: draft.storageKey,
            title: draft.title,
            detail: draft.detail,
            evidence: JSON.stringify(draft.evidence),
            suggestion: draft.suggestion,
            suggestedAction: draft.suggestedAction,
            fingerprint: draft.fingerprint,
          },
        });
        continue
      }

      if (prev.status === "DISMISSED") {
        // 人工忽略的问题只更新最近出现报告，不改变状态。
        await tx.qualityFinding.update({
          where: { id: prev.id },
          data: { reportId: report.id, lastSeenAt: new Date() },
        });
        continue
      }

      await tx.qualityFinding.update({
        where: { id: prev.id },
        data: {
          reportId: report.id,
          severity: draft.severity,
          category: draft.category,
          title: draft.title,
          detail: draft.detail,
          evidence: JSON.stringify(draft.evidence),
          suggestion: draft.suggestion,
          suggestedAction: draft.suggestedAction,
          status: "OPEN",
          lastSeenAt: new Date(),
          resolvedAt: null,
        },
      });
    }

    // 本次未命中的 OPEN 问题自动消解（DISABLED 之外）。
    const stale = existing.filter(
      (finding) => !touchedFps.has(finding.fingerprint) && finding.status === "OPEN",
    );
    if (stale.length) {
      await tx.qualityFinding.updateMany({
        where: { id: { in: stale.map((finding) => finding.id) } },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
    }

    return { reportId: report.id, summary, params };
  });
}

/**
 * 不改数据的分级复算：按当前规则版本重新评估全部未关闭问题。
 * 与 runScan 的区别是不收集磁盘/不产生新报告，只重算 severity/suggestion，
 * 已经消失的问题不会被这里置为 RESOLVED（那需要完整扫描）。
 */
export async function recomputeFindings(ownerId: string): Promise<{ recomputed: number }> {
  const [openFindings, latestReport] = await Promise.all([
    prisma.qualityFinding.findMany({ where: { ownerId, status: "OPEN" } }),
    prisma.qualityReport.findFirst({ where: { ownerId }, orderBy: { createdAt: "desc" } }),
  ]);

  const params = latestReport?.params ? (JSON.parse(latestReport.params) as { minYear: number; maxYear: number }) : null;

  const pending: Array<{ id: string; severity: FindingSeverity; suggestedAction: string }> = [];
  for (const finding of openFindings) {
    const next = reclassifyFinding(
      { ruleCode: finding.ruleCode, evidence: JSON.parse(finding.evidence) as Record<string, unknown> },
      {
        minYear: params?.minYear ?? DEFAULT_MIN_YEAR,
        maxYear: params?.maxYear ?? currentYearInTimezone("Asia/Shanghai") + 1,
      },
    );
    if (next && (next.severity !== finding.severity || next.suggestedAction !== finding.suggestedAction)) {
      pending.push({ id: finding.id, severity: next.severity, suggestedAction: next.suggestedAction });
    }
  }

  if (pending.length) {
    await prisma.$transaction(
      pending.map((item) =>
        prisma.qualityFinding.update({
          where: { id: item.id },
          data: { severity: item.severity, suggestedAction: item.suggestedAction },
        }),
      ),
    );
  }

  return { recomputed: pending.length };
}
