import type { Prisma } from "@prisma/client";
import { ApiError } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { applyFindingAction, rollbackAction, type ApplyParams } from "./actions";
import { recomputeFindings, runScan, type ScanOptions } from "./scan";
import type { ApplyActionBody, ListFindingsQuery, ListReportsQuery, ScanBody } from "./schema";

export const isAdmin = (role: string): boolean => role === "ADMIN";

export async function scan(userId: string, role: string, body: ScanBody) {
  const includeOrphanFiles = body.includeOrphanFiles === true;
  if (includeOrphanFiles && !isAdmin(role)) {
    throw new ApiError(403, "FORBIDDEN", "孤立文件扫描会读取全盘文件清单，仅管理员可执行；可改用服务器 CLI 脚本");
  }
  const options: ScanOptions = {
    ...(body.minYear !== undefined ? { minYear: body.minYear } : {}),
    ...(body.maxYear !== undefined ? { maxYear: body.maxYear } : {}),
    includeOrphanFiles,
    ...(body.categories ? { categories: body.categories } : {}),
  };
  return runScan(userId, options);
}

export function recompute(userId: string) {
  return recomputeFindings(userId);
}

const findingSelect: Prisma.QualityFindingSelect = {
  id: true,
  reportId: true,
  ruleCode: true,
  category: true,
  severity: true,
  status: true,
  entityType: true,
  entityId: true,
  storageKey: true,
  title: true,
  detail: true,
  evidence: true,
  suggestion: true,
  suggestedAction: true,
  firstSeenAt: true,
  lastSeenAt: true,
  resolvedAt: true,
  dismissedAt: true,
  createdAt: true,
  updatedAt: true,
};

function serializeFinding(finding: Prisma.QualityFindingGetPayload<{ select: typeof findingSelect }>) {
  return {
    ...finding,
    evidence: JSON.parse(finding.evidence) as unknown,
  };
}

export async function listFindings(userId: string, query: ListFindingsQuery) {
  const where: Prisma.QualityFindingWhereInput = {
    ownerId: userId,
    ...(query.status !== "ALL" ? { status: query.status } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.ruleCode ? { ruleCode: query.ruleCode } : {}),
  };

  const [items, total, counts] = await Promise.all([
    prisma.qualityFinding.findMany({
      where,
      select: findingSelect,
      orderBy: [
        { severity: "asc" },
        { status: "asc" },
        { lastSeenAt: "desc" },
      ],
      take: query.limit,
      skip: query.offset,
    }),
    prisma.qualityFinding.count({ where }),
    prisma.qualityFinding.groupBy({
      by: ["status", "severity"],
      where: { ownerId: userId },
      _count: { _all: true },
    }),
  ]);

  const statusCounts: Record<string, number> = { OPEN: 0, RESOLVED: 0, DISMISSED: 0 };
  const severityCounts: Record<string, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  for (const row of counts) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + row._count._all;
    severityCounts[row.severity] = (severityCounts[row.severity] ?? 0) + row._count._all;
  }

  return {
    items: items.map(serializeFinding),
    meta: { total, limit: query.limit, offset: query.offset, statusCounts, severityCounts },
  };
}

export async function getFinding(userId: string, findingId: string) {
  const finding = await prisma.qualityFinding.findFirst({ where: { id: findingId, ownerId: userId } });
  if (!finding) throw new ApiError(404, "NOT_FOUND", "体检问题不存在");
  const actions = await prisma.qualityAction.findMany({
    where: { findingId },
    orderBy: { executedAt: "desc" },
  });
  return {
    id: finding.id,
    reportId: finding.reportId,
    ruleCode: finding.ruleCode,
    category: finding.category,
    severity: finding.severity,
    status: finding.status,
    entityType: finding.entityType,
    entityId: finding.entityId,
    storageKey: finding.storageKey,
    title: finding.title,
    detail: finding.detail,
    evidence: JSON.parse(finding.evidence) as unknown,
    suggestion: finding.suggestion,
    suggestedAction: finding.suggestedAction,
    fingerprint: finding.fingerprint,
    firstSeenAt: finding.firstSeenAt,
    lastSeenAt: finding.lastSeenAt,
    resolvedAt: finding.resolvedAt,
    dismissedAt: finding.dismissedAt,
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
    actions: actions.map((action) => ({
      id: action.id,
      action: action.action,
      status: action.status,
      params: action.params ? (JSON.parse(action.params) as unknown) : null,
      beforeSnapshot: JSON.parse(action.beforeSnapshot) as unknown,
      afterSnapshot: action.afterSnapshot ? (JSON.parse(action.afterSnapshot) as unknown) : null,
      rollbackResult: action.rollbackResult ? (JSON.parse(action.rollbackResult) as unknown) : null,
      executedAt: action.executedAt,
      rolledBackAt: action.rolledBackAt,
    })),
  };
}

export async function listReports(userId: string, query: ListReportsQuery) {
  const where: Prisma.QualityReportWhereInput = { ownerId: userId };
  const [items, total] = await Promise.all([
    prisma.qualityReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
    }),
    prisma.qualityReport.count({ where }),
  ]);
  return {
    items: items.map((report) => ({
      id: report.id,
      rulesetVersion: report.rulesetVersion,
      status: report.status,
      summary: JSON.parse(report.summary) as unknown,
      params: report.params ? (JSON.parse(report.params) as unknown) : null,
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      createdAt: report.createdAt,
    })),
    meta: { total, limit: query.limit, offset: query.offset },
  };
}

export function applyAction(userId: string, findingId: string, body: ApplyActionBody) {
  return applyFindingAction(userId, findingId, body as ApplyParams);
}

export function rollback(userId: string, actionId: string) {
  return rollbackAction(userId, actionId);
}

export async function listActions(userId: string, query: { findingId?: string; limit: number; offset: number }) {
  const where: Prisma.QualityActionWhereInput = {
    ownerId: userId,
    ...(query.findingId ? { findingId: query.findingId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.qualityAction.findMany({
      where,
      orderBy: { executedAt: "desc" },
      take: query.limit,
      skip: query.offset,
    }),
    prisma.qualityAction.count({ where }),
  ]);
  return {
    items: items.map((action) => ({
      id: action.id,
      findingId: action.findingId,
      action: action.action,
      status: action.status,
      params: action.params ? (JSON.parse(action.params) as unknown) : null,
      afterSnapshot: action.afterSnapshot ? (JSON.parse(action.afterSnapshot) as unknown) : null,
      rollbackResult: action.rollbackResult ? (JSON.parse(action.rollbackResult) as unknown) : null,
      executedAt: action.executedAt,
      rolledBackAt: action.rolledBackAt,
    })),
    meta: { total, limit: query.limit, offset: query.offset },
  };
}
