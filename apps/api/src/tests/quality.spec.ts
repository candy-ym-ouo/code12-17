import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import {
  auth,
  createObservationViaApi,
  createSite,
  createSpeciesWithPhase,
  registerUser,
  resetDatabase,
  type RegisteredUser,
} from "./helpers/db";

async function resetUploads(): Promise<void> {
  await fs.rm(env.uploadDir, { recursive: true, force: true });
}

async function scan(user: RegisteredUser, query = "") {
  const response = await user.agent.get(`/api/v1/quality/scan${query}`).set(auth(user.accessToken));
  expect(response.status).toBe(200);
  return response.body.data;
}

function findingsOf(report: any, ruleId: string) {
  return report.findings.filter((finding: any) => finding.ruleId === ruleId);
}

async function writeOrphanFile(variant: string, key: string): Promise<string> {
  const target = path.join(env.uploadDir, variant, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from("orphan-bytes"));
  return target;
}

describe("数据质量体检", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetUploads();
  });

  it("未登录访问返回 401", async () => {
    const user = await registerUser();
    const response = await user.agent.get("/api/v1/quality/scan");
    expect(response.status).toBe(401);
  });

  it("识别各类日期越界并分级", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);

    // 合法但未来的日期（API 放行，体检负责标记）
    await createObservationViaApi(user, { siteId: site.id, kind: "PLANT_PHENOLOGY", observationDate: "2099-01-01" });
    // 早于 1900 年
    await createObservationViaApi(user, { siteId: site.id, kind: "PLANT_PHENOLOGY", observationDate: "1850-05-01" });
    // 早于地点创建时间
    await createObservationViaApi(user, { siteId: site.id, kind: "PLANT_PHENOLOGY", observationDate: "2020-01-01" });
    // observedAt 与 observationDate 偏差超过一年
    await createObservationViaApi(user, {
      siteId: site.id,
      kind: "PLANT_PHENOLOGY",
      observationDate: "2025-03-01",
      observedAt: "2020-01-01T00:00:00.000Z",
    });
    // 非法日期只能直接写库（模拟历史迁移遗留）
    await prisma.observation.create({
      data: { ownerId: user.id, siteId: site.id, kind: "PLANT_PHENOLOGY", observationDate: "2025-13-40" },
    });

    const report = await scan(user, "?referenceDate=2026-10-07");

    expect(findingsOf(report, "date.invalid")).toHaveLength(1);
    expect(findingsOf(report, "date.invalid")[0].severity).toBe("CRITICAL");

    expect(findingsOf(report, "date.future")).toHaveLength(1);
    expect(findingsOf(report, "date.future")[0].details.observationDate).toBe("2099-01-01");

    expect(findingsOf(report, "date.too-old")).toHaveLength(1);

    // 1850-05-01 与 2020-01-01 均早于地点创建日
    expect(findingsOf(report, "date.before-site").length).toBeGreaterThanOrEqual(2);

    const gap = findingsOf(report, "date.observed-at-gap");
    expect(gap).toHaveLength(1);
    expect(gap[0].severity).toBe("WARNING");
    expect(gap[0].details.gapDays).toBeGreaterThan(366);

    expect(report.summary.bySeverity.CRITICAL).toBe(1);
    expect(report.summary.byCategory.DATE_OUT_OF_RANGE).toBe(report.findings.length);
  });

  it("识别阶段缺失、阶段错配与物种无阶段", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);
    const { speciesId, phenophaseId } = await createSpeciesWithPhase(user.id, { commonName: "银杏" });
    const other = await createSpeciesWithPhase(user.id, { commonName: "垂柳" });

    // 已发布但缺阶段
    await createObservationViaApi(user, {
      siteId: site.id,
      speciesId,
      kind: "PLANT_PHENOLOGY",
      observationDate: "2026-04-01",
    });
    // 草稿缺阶段不标记
    await createObservationViaApi(user, {
      siteId: site.id,
      speciesId,
      kind: "PLANT_PHENOLOGY",
      status: "DRAFT",
      observationDate: "2026-04-02",
    });
    // 阶段错配：阶段属于另一个物种（直接改库模拟迁移遗留）
    const mismatched = await createObservationViaApi(user, {
      siteId: site.id,
      speciesId,
      phenophaseId,
      kind: "PLANT_PHENOLOGY",
      observationDate: "2026-04-03",
    });
    const mismatchedId = mismatched.body.data.id as string;
    await prisma.observation.update({ where: { id: mismatchedId }, data: { phenophaseId: other.phenophaseId } });
    // 无阶段物种
    await prisma.species.create({ data: { ownerId: user.id, category: "BIRD", commonName: "麻雀" } });

    const report = await scan(user, "?referenceDate=2026-10-07");

    expect(findingsOf(report, "stage.missing")).toHaveLength(1);
    expect(findingsOf(report, "stage.missing")[0].severity).toBe("WARNING");

    const mismatch = findingsOf(report, "stage.mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe("CRITICAL");
    expect(mismatch[0].action).toBe("clear_phenophase");
    expect(mismatch[0].entity.id).toBe(mismatchedId);

    expect(findingsOf(report, "stage.species-no-phases")).toHaveLength(1);
  });

  it("识别孤立文件与丢失文件", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);
    const observation = await createObservationViaApi(user, {
      siteId: site.id,
      kind: "WEATHER_ANOMALY",
      anomalyType: "COLD_WAVE",
      observationDate: "2026-03-01",
    });
    const observationId = observation.body.data.id as string;

    // 磁盘上有文件但没有任何记录引用
    await writeOrphanFile("original", "2024/01/00000000-0000-0000-0000-0000000000aa.webp");
    // 有照片记录但三个变体文件全部丢失
    const lost = await prisma.observationPhoto.create({
      data: {
        observationId,
        storageKey: "2026/03/00000000-0000-0000-0000-0000000000bb.webp",
        thumbKey: "2026/03/00000000-0000-0000-0000-0000000000bb.webp",
        displayKey: "2026/03/00000000-0000-0000-0000-0000000000bb.webp",
        originalName: "lost.jpg",
        mimeType: "image/webp",
        width: 10,
        height: 10,
        bytes: 10,
      },
    });
    // 部分丢失：仅 original 还在
    const partialKey = "2026/03/00000000-0000-0000-0000-0000000000cc.webp";
    await prisma.observationPhoto.create({
      data: {
        observationId,
        storageKey: partialKey,
        thumbKey: partialKey,
        displayKey: partialKey,
        originalName: "partial.jpg",
        mimeType: "image/webp",
        width: 10,
        height: 10,
        bytes: 10,
      },
    });
    await writeOrphanFile("original", partialKey);

    const report = await scan(user, "?referenceDate=2026-10-07");

    const orphans = findingsOf(report, "file.orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].action).toBe("quarantine_files");
    expect(orphans[0].entity.id).toBe("original/2024/01/00000000-0000-0000-0000-0000000000aa.webp");

    const missing = findingsOf(report, "file.missing");
    expect(missing).toHaveLength(2);
    const lostFinding = missing.find((item: any) => item.entity.id === lost.id);
    expect(lostFinding.severity).toBe("CRITICAL");
    expect(lostFinding.action).toBe("drop_photo_record");
    const partialFinding = missing.find((item: any) => item.entity.id !== lost.id);
    expect(partialFinding.severity).toBe("WARNING");
    expect(partialFinding.action).toBeUndefined();
  });

  it("同一参照日重复体检结论完全一致（可复算）", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);
    // 2025-06-15 相对 2026-10-07 是正常历史日期，相对 2020-01-01 则是未来日期
    await createObservationViaApi(user, { siteId: site.id, kind: "PLANT_PHENOLOGY", observationDate: "2025-06-15" });
    await writeOrphanFile("thumb", "2024/02/00000000-0000-0000-0000-0000000000dd.webp");

    const first = await scan(user, "?referenceDate=2026-10-07");
    const second = await scan(user, "?referenceDate=2026-10-07");
    expect(first.digest).toBe(second.digest);
    expect(first.findings.map((f: any) => f.fingerprint)).toEqual(second.findings.map((f: any) => f.fingerprint));

    // 参照日前移后，未来日判定变化，digest 随之变化
    const earlier = await scan(user, "?referenceDate=2020-01-01");
    expect(findingsOf(earlier, "date.future")).toHaveLength(1);
    expect(findingsOf(first, "date.future")).toHaveLength(0);
    expect(earlier.digest).not.toBe(first.digest);
  });

  it("categories 只过滤 findings 列表，不影响全量摘要与指纹", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);
    await createObservationViaApi(user, { siteId: site.id, kind: "PLANT_PHENOLOGY", observationDate: "2099-01-01" });
    await writeOrphanFile("original", "2024/01/00000000-0000-0000-0000-0000000000ee.webp");

    const full = await scan(user, "?referenceDate=2026-10-07");
    const filtered = await scan(user, "?referenceDate=2026-10-07&categories=ORPHAN_FILE");
    expect(filtered.digest).toBe(full.digest);
    expect(filtered.summary.total).toBe(full.summary.total);
    expect(filtered.findings.every((f: any) => f.category === "ORPHAN_FILE")).toBe(true);
  });

  it("隔离孤立文件并凭凭据回滚", async () => {
    const user = await registerUser();
    await createSite(user.id);
    const key = "2024/01/00000000-0000-0000-0000-0000000000ff.webp";
    const orphanPath = await writeOrphanFile("original", key);

    const before = await scan(user);
    const target = findingsOf(before, "file.orphan")[0];

    const executed = await user.agent
      .post("/api/v1/quality/actions")
      .set(auth(user.accessToken))
      .send({ action: "quarantine_files", fingerprints: [target.fingerprint] });
    expect(executed.status).toBe(201);
    const manifest = executed.body.data;
    expect(manifest.items[0].status).toBe("applied");
    expect(manifest.items[0].rollback.type).toBe("file_move");

    // 文件已迁入隔离区，原位置与空目录已清理
    await expect(fs.access(orphanPath)).rejects.toThrow();
    const quarantined = path.join(env.uploadDir, ".quality", "quarantine", manifest.actionId, "original", key);
    await fs.access(quarantined);
    expect(findingsOf(await scan(user), "file.orphan")).toHaveLength(0);

    // 处置列表可见
    const listed = await user.agent.get("/api/v1/quality/actions").set(auth(user.accessToken));
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].applied).toBe(1);

    // 回滚：文件回到原位，再次扫描出现相同指纹的发现
    const rolledBack = await user.agent
      .post(`/api/v1/quality/actions/${manifest.actionId}/rollback`)
      .set(auth(user.accessToken));
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body.data.status).toBe("ROLLED_BACK");
    expect(rolledBack.body.data.items[0].rollbackStatus).toBe("restored");
    await fs.access(orphanPath);

    const after = await scan(user);
    const restored = findingsOf(after, "file.orphan");
    expect(restored).toHaveLength(1);
    expect(restored[0].fingerprint).toBe(target.fingerprint);
  });

  it("清空错配阶段并回滚恢复原值", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);
    const { speciesId, phenophaseId } = await createSpeciesWithPhase(user.id);
    const other = await createSpeciesWithPhase(user.id, { commonName: "垂柳" });
    const created = await createObservationViaApi(user, {
      siteId: site.id,
      speciesId,
      phenophaseId,
      kind: "PLANT_PHENOLOGY",
      observationDate: "2026-04-03",
    });
    const observationId = created.body.data.id as string;
    await prisma.observation.update({ where: { id: observationId }, data: { phenophaseId: other.phenophaseId } });

    const report = await scan(user);
    const target = findingsOf(report, "stage.mismatch")[0];

    const executed = await user.agent
      .post("/api/v1/quality/actions")
      .set(auth(user.accessToken))
      .send({ action: "clear_phenophase", fingerprints: [target.fingerprint] });
    expect(executed.status).toBe(201);
    expect(executed.body.data.items[0].rollback).toMatchObject({ type: "field_restore", previousValue: other.phenophaseId });
    expect((await prisma.observation.findUnique({ where: { id: observationId } }))?.phenophaseId).toBeNull();

    const rolledBack = await user.agent
      .post(`/api/v1/quality/actions/${executed.body.data.actionId}/rollback`)
      .set(auth(user.accessToken));
    expect(rolledBack.body.data.status).toBe("ROLLED_BACK");
    expect((await prisma.observation.findUnique({ where: { id: observationId } }))?.phenophaseId).toBe(other.phenophaseId);
  });

  it("移除丢失照片的记录并回滚恢复整行", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);
    const observation = await createObservationViaApi(user, {
      siteId: site.id,
      kind: "WEATHER_ANOMALY",
      anomalyType: "COLD_WAVE",
      observationDate: "2026-03-01",
    });
    const photo = await prisma.observationPhoto.create({
      data: {
        observationId: observation.body.data.id,
        storageKey: "2026/03/00000000-0000-0000-0000-000000000011.webp",
        thumbKey: "2026/03/00000000-0000-0000-0000-000000000011.webp",
        displayKey: "2026/03/00000000-0000-0000-0000-000000000011.webp",
        originalName: "lost.jpg",
        mimeType: "image/webp",
        width: 10,
        height: 10,
        bytes: 10,
      },
    });

    const report = await scan(user);
    const target = findingsOf(report, "file.missing")[0];

    const executed = await user.agent
      .post("/api/v1/quality/actions")
      .set(auth(user.accessToken))
      .send({ action: "drop_photo_record", fingerprints: [target.fingerprint] });
    expect(executed.status).toBe(201);
    expect(executed.body.data.items[0].rollback.type).toBe("row_restore");
    expect(await prisma.observationPhoto.findUnique({ where: { id: photo.id } })).toBeNull();

    const rolledBack = await user.agent
      .post(`/api/v1/quality/actions/${executed.body.data.actionId}/rollback`)
      .set(auth(user.accessToken));
    expect(rolledBack.body.data.status).toBe("ROLLED_BACK");
    const restored = await prisma.observationPhoto.findUnique({ where: { id: photo.id } });
    expect(restored).not.toBeNull();
    expect(restored?.originalName).toBe("lost.jpg");
  });

  it("失效指纹与动作不匹配的发现会被跳过", async () => {
    const user = await registerUser();
    const site = await createSite(user.id);
    await createObservationViaApi(user, { siteId: site.id, kind: "PLANT_PHENOLOGY", observationDate: "2099-01-01" });

    const response = await user.agent
      .post("/api/v1/quality/actions")
      .set(auth(user.accessToken))
      .send({ action: "quarantine_files", fingerprints: ["0123456789abcdef"] });
    expect(response.status).toBe(201);
    expect(response.body.data.items[0].status).toBe("skipped");

    // date.future 发现不支持任何处置动作
    const report = await scan(user);
    const dateFinding = findingsOf(report, "date.future")[0];
    const mismatched = await user.agent
      .post("/api/v1/quality/actions")
      .set(auth(user.accessToken))
      .send({ action: "clear_phenophase", fingerprints: [dateFinding.fingerprint] });
    expect(mismatched.body.data.items[0].status).toBe("skipped");
  });

  it("重复回滚返回 409", async () => {
    const user = await registerUser();
    await createSite(user.id);
    await writeOrphanFile("original", "2024/01/00000000-0000-0000-0000-000000000022.webp");

    const report = await scan(user);
    const target = findingsOf(report, "file.orphan")[0];
    const executed = await user.agent
      .post("/api/v1/quality/actions")
      .set(auth(user.accessToken))
      .send({ action: "quarantine_files", fingerprints: [target.fingerprint] });
    const actionId = executed.body.data.actionId;

    await user.agent.post(`/api/v1/quality/actions/${actionId}/rollback`).set(auth(user.accessToken));
    const again = await user.agent.post(`/api/v1/quality/actions/${actionId}/rollback`).set(auth(user.accessToken));
    expect(again.status).toBe(409);
  });
});
