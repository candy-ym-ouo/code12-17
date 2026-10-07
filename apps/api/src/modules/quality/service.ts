import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import { dateInTimezone, todayInTimezone } from "../../lib/date";
import { ApiError } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { storage, type StorageVariant } from "../../lib/storage";
import {
  digestFindings,
  evaluateSnapshot,
  RULES,
  RULESET_VERSION,
  type ActionKind,
  type Finding,
  type FindingCategory,
  type QualitySnapshot,
  type Severity,
} from "./rules";
import type { ScanQuery } from "./schema";

const STORAGE_VARIANTS: StorageVariant[] = ["thumb", "display", "original"];
const KEY_PATTERN = /^[A-Za-z0-9/_-]+\.webp$/;

// 处置凭据与隔离文件统一放在上传目录下的 .quality/ 中，随上传目录一起备份即可。
const qualityDir = () => path.join(env.uploadDir, ".quality");
const actionsDir = () => path.join(qualityDir(), "actions");
const quarantineDir = () => path.join(qualityDir(), "quarantine");

export interface QualityReport {
  rulesetVersion: string;
  referenceDate: string;
  generatedAt: string;
  digest: string;
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    byCategory: Record<FindingCategory, number>;
  };
  rules: Array<(typeof RULES)[number] & { count: number }>;
  findings: Finding[];
}

export interface ManifestItem {
  fingerprint: string;
  status: "applied" | "skipped" | "failed";
  reason?: string;
  /** 回滚凭据：撤销该处置项所需的全部信息。 */
  rollback: Record<string, unknown>;
  rollbackStatus?: "restored" | "conflict" | "failed";
  rollbackReason?: string;
}

export interface ActionManifest {
  actionId: string;
  action: ActionKind;
  actorId: string;
  rulesetVersion: string;
  createdAt: string;
  status: "APPLIED" | "ROLLED_BACK" | "PARTIAL_ROLLBACK";
  items: ManifestItem[];
  rolledBackAt?: string;
}

async function loadSnapshot(userId: string, timezone: string): Promise<QualitySnapshot> {
  const [observations, speciesList, photos, allPhotoKeys, ...variantKeys] = await Promise.all([
    prisma.observation.findMany({
      where: { ownerId: userId },
      include: {
        site: { select: { createdAt: true } },
        phenophase: { select: { speciesId: true } },
        species: { select: { _count: { select: { phenophases: true } } } },
      },
    }),
    prisma.species.findMany({
      where: { ownerId: userId },
      select: { id: true, commonName: true, archivedAt: true, _count: { select: { phenophases: true } } },
    }),
    prisma.observationPhoto.findMany({ where: { observation: { ownerId: userId } } }),
    prisma.observationPhoto.findMany({ select: { storageKey: true, thumbKey: true, displayKey: true } }),
    ...STORAGE_VARIANTS.map((variant) => storage.list(variant)),
  ]);

  const knownKeys = new Set<string>();
  for (const row of allPhotoKeys) {
    knownKeys.add(row.storageKey);
    knownKeys.add(row.thumbKey);
    knownKeys.add(row.displayKey);
  }

  const diskFiles = STORAGE_VARIANTS.flatMap((variant, index) =>
    variantKeys[index].map((key) => ({ variant, key })),
  );

  return {
    observations: observations.map((obs) => ({
      id: obs.id,
      kind: obs.kind,
      status: obs.status,
      observationDate: obs.observationDate,
      observedAtDate: obs.observedAt ? dateInTimezone(obs.observedAt, timezone) : null,
      siteId: obs.siteId,
      siteCreatedDate: dateInTimezone(obs.site.createdAt, timezone),
      speciesId: obs.speciesId,
      phenophaseId: obs.phenophaseId,
      phenophaseSpeciesId: obs.phenophase?.speciesId ?? null,
      speciesPhenophaseCount: obs.species?._count.phenophases ?? null,
    })),
    species: speciesList.map((item) => ({
      id: item.id,
      commonName: item.commonName,
      phenophaseCount: item._count.phenophases,
      archived: item.archivedAt !== null,
    })),
    photos: photos.map((photo) => ({
      id: photo.id,
      observationId: photo.observationId,
      storageKey: photo.storageKey,
      thumbKey: photo.thumbKey,
      displayKey: photo.displayKey,
    })),
    knownKeys,
    diskFiles,
  };
}

export async function runScan(userId: string, query: ScanQuery): Promise<QualityReport> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "Asia/Shanghai";
  const referenceDate = query.referenceDate ?? todayInTimezone(timezone);

  const snapshot = await loadSnapshot(userId, timezone);
  const all = evaluateSnapshot(snapshot, referenceDate);

  const categories = query.categories.length ? new Set(query.categories) : null;
  const findings = categories ? all.filter((finding) => categories.has(finding.category)) : all;

  const bySeverity: Record<Severity, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  const byCategory: Record<FindingCategory, number> = { DATE_OUT_OF_RANGE: 0, MISSING_STAGE: 0, ORPHAN_FILE: 0 };
  for (const finding of all) {
    bySeverity[finding.severity] += 1;
    byCategory[finding.category] += 1;
  }

  return {
    rulesetVersion: RULESET_VERSION,
    referenceDate,
    generatedAt: new Date().toISOString(),
    digest: digestFindings(all),
    summary: { total: all.length, bySeverity, byCategory },
    rules: RULES.map((rule) => ({ ...rule, count: all.filter((finding) => finding.ruleId === rule.id).length })),
    findings,
  };
}

// ---------- 处置动作 ----------

function resolveVariantPath(variant: StorageVariant, key: string): string {
  if (!KEY_PATTERN.test(key) || key.includes("..")) {
    throw new ApiError(400, "VALIDATION_ERROR", `非法的存储 key：${key}`);
  }
  const target = path.resolve(env.uploadDir, variant, key);
  if (!target.startsWith(path.resolve(env.uploadDir, variant) + path.sep)) {
    throw new ApiError(400, "VALIDATION_ERROR", "存储路径越界");
  }
  return target;
}

/** 解析 .quality 内部的相对路径，禁止逃逸出 .quality 目录。 */
function resolveQualityPath(relative: string): string {
  const target = path.resolve(qualityDir(), relative);
  if (!target.startsWith(qualityDir() + path.sep)) {
    throw new ApiError(400, "VALIDATION_ERROR", "凭据路径越界");
  }
  return target;
}

async function moveFile(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
}

/** 移动文件后顺手清理变体目录下空掉的年/月目录。 */
async function pruneEmptyDirs(from: string, stopAt: string): Promise<void> {
  let current = from;
  while (current !== stopAt && current.startsWith(stopAt + path.sep)) {
    try {
      await fs.rmdir(current);
    } catch {
      break; // 非空或已不存在，停止向上
    }
    current = path.dirname(current);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function applyQuarantine(actionId: string, finding: Finding): Promise<ManifestItem> {
  const { variant, key } = finding.details as { variant: StorageVariant; key: string };
  const source = resolveVariantPath(variant, key);
  const quarantineKey = path.posix.join("quarantine", actionId, variant, key);
  const target = resolveQualityPath(quarantineKey);

  if (!(await pathExists(source))) {
    return { fingerprint: finding.fingerprint, status: "skipped", reason: "文件已不存在", rollback: {} };
  }
  await moveFile(source, target);
  await pruneEmptyDirs(path.dirname(source), path.resolve(env.uploadDir, variant));
  return {
    fingerprint: finding.fingerprint,
    status: "applied",
    rollback: { type: "file_move", variant, key, quarantineKey },
  };
}

async function applyClearPhenophase(finding: Finding): Promise<ManifestItem> {
  const observationId = finding.entity.id;
  const previous = String(finding.details.phenophaseId ?? "");
  // 条件更新：只有当前值仍是扫描时的值才清零，避免覆盖他人刚做的修改
  const result = await prisma.observation.updateMany({
    where: { id: observationId, phenophaseId: previous },
    data: { phenophaseId: null },
  });
  if (result.count === 0) {
    return { fingerprint: finding.fingerprint, status: "skipped", reason: "记录已被修改，未执行", rollback: {} };
  }
  return {
    fingerprint: finding.fingerprint,
    status: "applied",
    rollback: { type: "field_restore", observationId, field: "phenophaseId", previousValue: previous },
  };
}

async function applyDropPhotoRecord(finding: Finding): Promise<ManifestItem> {
  const photo = await prisma.observationPhoto.findUnique({ where: { id: finding.entity.id } });
  if (!photo) {
    return { fingerprint: finding.fingerprint, status: "skipped", reason: "照片记录已不存在", rollback: {} };
  }
  await prisma.observationPhoto.delete({ where: { id: photo.id } });
  return {
    fingerprint: finding.fingerprint,
    status: "applied",
    rollback: { type: "row_restore", table: "ObservationPhoto", row: photo },
  };
}

async function writeManifest(manifest: ActionManifest): Promise<void> {
  await fs.mkdir(actionsDir(), { recursive: true });
  const target = path.join(actionsDir(), `${manifest.actionId}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fs.rename(tmp, target);
}

async function readManifest(actionId: string): Promise<ActionManifest | null> {
  try {
    const raw = await fs.readFile(path.join(actionsDir(), `${actionId}.json`), "utf8");
    return JSON.parse(raw) as ActionManifest;
  } catch {
    return null;
  }
}

export async function executeAction(userId: string, input: { action: ActionKind; fingerprints: string[] }): Promise<ActionManifest> {
  // 先复算当前状态：只有仍然存在的发现才允许处置，指纹对不上的一律跳过
  const report = await runScan(userId, { categories: [], referenceDate: undefined });
  const current = new Map(report.findings.map((finding) => [finding.fingerprint, finding]));

  const actionId = crypto.randomUUID();
  const items: ManifestItem[] = [];
  for (const fingerprint of input.fingerprints) {
    const finding = current.get(fingerprint);
    if (!finding) {
      items.push({ fingerprint, status: "skipped", reason: "该发现在当前数据中已不存在（可能已被修复）", rollback: {} });
      continue;
    }
    if (finding.action !== input.action) {
      items.push({ fingerprint, status: "skipped", reason: "该发现不支持此处置动作", rollback: {} });
      continue;
    }
    try {
      if (input.action === "quarantine_files") items.push(await applyQuarantine(actionId, finding));
      else if (input.action === "clear_phenophase") items.push(await applyClearPhenophase(finding));
      else items.push(await applyDropPhotoRecord(finding));
    } catch (error) {
      items.push({
        fingerprint,
        status: "failed",
        reason: error instanceof Error ? error.message : "执行失败",
        rollback: {},
      });
    }
  }

  const manifest: ActionManifest = {
    actionId,
    action: input.action,
    actorId: userId,
    rulesetVersion: RULESET_VERSION,
    createdAt: new Date().toISOString(),
    status: "APPLIED",
    items,
  };
  await writeManifest(manifest);
  return manifest;
}

// ---------- 回滚 ----------

async function revertItem(action: ActionKind, item: ManifestItem): Promise<Pick<ManifestItem, "rollbackStatus" | "rollbackReason">> {
  const credential = item.rollback as { type?: string };
  try {
    if (credential.type === "file_move") {
      const { variant, key, quarantineKey } = item.rollback as { variant: StorageVariant; key: string; quarantineKey: string };
      const quarantined = resolveQualityPath(quarantineKey);
      const destination = resolveVariantPath(variant, key);
      if (await pathExists(destination)) return { rollbackStatus: "conflict", rollbackReason: "原位置已存在同名文件，未覆盖" };
      if (!(await pathExists(quarantined))) return { rollbackStatus: "failed", rollbackReason: "隔离文件已不存在" };
      await moveFile(quarantined, destination);
      await pruneEmptyDirs(path.dirname(quarantined), quarantineDir());
      return { rollbackStatus: "restored" };
    }
    if (credential.type === "field_restore") {
      const { observationId, previousValue } = item.rollback as { observationId: string; previousValue: string };
      const phase = await prisma.phenophase.findUnique({ where: { id: previousValue }, select: { id: true } });
      if (!phase) return { rollbackStatus: "conflict", rollbackReason: "原物候阶段已被删除，无法恢复" };
      const result = await prisma.observation.updateMany({
        where: { id: observationId, phenophaseId: null },
        data: { phenophaseId: previousValue },
      });
      if (result.count === 0) return { rollbackStatus: "conflict", rollbackReason: "记录当前阶段非空，未覆盖" };
      return { rollbackStatus: "restored" };
    }
    if (credential.type === "row_restore") {
      const row = item.rollback.row as Record<string, unknown> & { id: string; observationId: string };
      const existing = await prisma.observationPhoto.findUnique({ where: { id: row.id }, select: { id: true } });
      if (existing) return { rollbackStatus: "conflict", rollbackReason: "照片记录已存在，未重复写入" };
      const observation = await prisma.observation.findUnique({ where: { id: row.observationId }, select: { id: true } });
      if (!observation) return { rollbackStatus: "conflict", rollbackReason: "所属观测已删除，无法恢复照片记录" };
      await prisma.observationPhoto.create({
        data: {
          id: row.id,
          observationId: row.observationId,
          storageKey: String(row.storageKey),
          thumbKey: String(row.thumbKey),
          displayKey: String(row.displayKey),
          originalName: String(row.originalName),
          mimeType: String(row.mimeType),
          width: Number(row.width),
          height: Number(row.height),
          bytes: Number(row.bytes),
          takenAt: row.takenAt ? new Date(String(row.takenAt)) : null,
          gpsStripped: Boolean(row.gpsStripped),
          sortOrder: Number(row.sortOrder),
          createdAt: new Date(String(row.createdAt)),
        },
      });
      return { rollbackStatus: "restored" };
    }
    return { rollbackStatus: "failed", rollbackReason: `未知的凭据类型：${String(credential.type)}` };
  } catch (error) {
    return { rollbackStatus: "failed", rollbackReason: error instanceof Error ? error.message : "回滚失败" };
  }
}

async function loadOwnedManifest(userId: string, actionId: string): Promise<ActionManifest> {
  const manifest = await readManifest(actionId);
  if (!manifest || manifest.actorId !== userId) {
    throw new ApiError(404, "NOT_FOUND", "处置记录不存在");
  }
  return manifest;
}

export async function rollbackAction(userId: string, actionId: string): Promise<ActionManifest> {
  const manifest = await loadOwnedManifest(userId, actionId);
  if (manifest.status === "ROLLED_BACK") {
    throw new ApiError(409, "ROLLBACK_CONFLICT", "该处置已完整回滚，无需重复操作");
  }
  for (const item of manifest.items) {
    if (item.status !== "applied" || item.rollbackStatus === "restored") continue;
    Object.assign(item, await revertItem(manifest.action, item));
  }
  const fullyRestored = manifest.items.every((item) => item.status !== "applied" || item.rollbackStatus === "restored");
  manifest.status = fullyRestored ? "ROLLED_BACK" : "PARTIAL_ROLLBACK";
  manifest.rolledBackAt = new Date().toISOString();
  await writeManifest(manifest);
  return manifest;
}

export async function getAction(userId: string, actionId: string): Promise<ActionManifest> {
  return loadOwnedManifest(userId, actionId);
}

export async function listActions(userId: string): Promise<Array<Record<string, unknown>>> {
  let files: string[] = [];
  try {
    files = await fs.readdir(actionsDir());
  } catch {
    return [];
  }
  const manifests: ActionManifest[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const manifest = await readManifest(file.slice(0, -".json".length));
    if (manifest && manifest.actorId === userId) manifests.push(manifest);
  }
  return manifests
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((manifest) => ({
      actionId: manifest.actionId,
      action: manifest.action,
      status: manifest.status,
      createdAt: manifest.createdAt,
      rolledBackAt: manifest.rolledBackAt ?? null,
      total: manifest.items.length,
      applied: manifest.items.filter((item) => item.status === "applied").length,
      skipped: manifest.items.filter((item) => item.status === "skipped").length,
      failed: manifest.items.filter((item) => item.status === "failed").length,
    }));
}
