import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./helpers/db";
import { auth, createSite, createSpeciesWithPhase, registerUser, resetDatabase } from "./helpers/db";
import { prisma } from "../lib/prisma";
import { storage } from "../lib/storage";
import { reclassifyFinding, runRuleset } from "../modules/quality/rules";

describe("数据质量体检", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe("规则引擎（纯函数，可复算）", () => {
    it("识别非法日期、越界日期与 observedAt 不一致", () => {
      const result = runRuleset("user-1", {
        observations: [
          {
            id: "o1",
            kind: "PLANT_PHENOLOGY",
            status: "PUBLISHED",
            observationDate: "2025-02-30",
            observedAt: null,
            speciesId: "sp1",
            phenophaseId: "ph1",
            title: "坏日期",
            siteName: "A",
            photoCount: 0,
          },
          {
            id: "o2",
            kind: "INSECT_SIGHTING",
            status: "PUBLISHED",
            observationDate: "2052-04-01",
            observedAt: null,
            speciesId: null,
            phenophaseId: null,
            title: "年份越界",
            siteName: "A",
            photoCount: 0,
          },
          {
            id: "o3",
            kind: "BIRD_SOUND",
            status: "PUBLISHED",
            observationDate: "2025-04-01",
            observedAt: new Date("2025-04-02T00:00:00.000Z"),
            speciesId: null,
            phenophaseId: null,
            title: "时间戳漂移",
            siteName: "A",
            photoCount: 0,
          },
        ],
        photos: [],
        files: [],
        includeOrphanFiles: false,
        minYear: 1990,
        maxYear: 2026,
      });

      const codes = result.findings.map((f) => f.ruleCode);
      expect(codes).toContain("DATE_INVALID");
      expect(codes).toContain("DATE_OUT_OF_RANGE");
      expect(codes).toContain("DATE_OBSERVED_AT_MISMATCH");
      expect(result.summary.byCategory.DATE).toBe(3);
      expect(result.findings.find((f) => f.ruleCode === "DATE_INVALID")?.severity).toBe("CRITICAL");
      expect(result.findings.find((f) => f.ruleCode === "DATE_OUT_OF_RANGE")?.severity).toBe("WARNING");
    });

    it("识别植物物候缺阶段、有阶段缺物种", () => {
      const result = runRuleset("user-1", {
        observations: [
          {
            id: "o1",
            kind: "PLANT_PHENOLOGY",
            status: "PUBLISHED",
            observationDate: "2025-04-01",
            observedAt: null,
            speciesId: "sp1",
            phenophaseId: null,
            title: "缺阶段",
            siteName: "A",
            photoCount: 0,
          },
          {
            id: "o2",
            kind: "PLANT_PHENOLOGY",
            status: "PUBLISHED",
            observationDate: "2025-04-01",
            observedAt: null,
            speciesId: null,
            phenophaseId: "ph1",
            title: "缺物种",
            siteName: "A",
            photoCount: 0,
          },
        ],
        photos: [],
        files: [],
        includeOrphanFiles: false,
        minYear: 1990,
        maxYear: 2026,
      });
      const codes = result.findings.map((f) => f.ruleCode);
      expect(codes).toEqual(expect.arrayContaining(["PHASE_MISSING_FOR_PLANT", "PHASE_WITHOUT_SPECIES"]));
    });

    it("识别照片文件缺失与孤立文件，并按缺失数量分级", () => {
      const result = runRuleset("user-1", {
        observations: [],
        photos: [
          {
            id: "p1",
            observationId: "o1",
            storageKey: "2025/04/all-missing.webp",
            thumbKey: "2025/04/all-missing.webp",
            displayKey: "2025/04/all-missing.webp",
            originalName: "全丢.jpg",
          },
          {
            id: "p2",
            observationId: "o2",
            storageKey: "2025/04/original-only-missing.webp",
            thumbKey: "2025/04/original-only-missing.webp",
            displayKey: "2025/04/original-only-missing.webp",
            originalName: "缺原图.jpg",
          },
        ],
        files: [
          { key: "2025/04/original-only-missing.webp", variant: "thumb", bytes: 10 },
          { key: "2025/04/original-only-missing.webp", variant: "display", bytes: 20 },
          { key: "2025/04/orphan.webp", variant: "thumb", bytes: 1 },
          { key: "2025/04/orphan.webp", variant: "display", bytes: 1 },
          { key: "2025/04/orphan.webp", variant: "original", bytes: 1 },
        ],
        includeOrphanFiles: true,
        minYear: 1990,
        maxYear: 2026,
      });

      const allMissing = result.findings.find((f) => f.entityId === "p1");
      const partial = result.findings.find((f) => f.entityId === "p2");
      const orphan = result.findings.find((f) => f.ruleCode === "FILE_ORPHAN");
      expect(allMissing?.severity).toBe("CRITICAL");
      expect(allMissing?.suggestedAction).toBe("DROP_PHOTO_ROW");
      expect(partial?.severity).toBe("WARNING");
      expect(orphan?.severity).toBe("WARNING");
      expect(orphan?.storageKey).toBe("2025/04/orphan.webp");
    });

    it("fingerprint 稳定：同一实体两次扫描得到相同指纹", () => {
      const input = {
        observations: [
          {
            id: "o1",
            kind: "PLANT_PHENOLOGY",
            status: "PUBLISHED" as const,
            observationDate: "bad-date",
            observedAt: null,
            speciesId: "sp1",
            phenophaseId: null,
            title: "x",
            siteName: "A",
            photoCount: 0,
          },
        ],
        photos: [],
        files: [],
        includeOrphanFiles: false,
        minYear: 1990,
        maxYear: 2026,
      };
      const a = runRuleset("u1", input);
      const b = runRuleset("u1", input);
      expect(a.findings[0].fingerprint).toBe(b.findings[0].fingerprint);
      // 不同用户同一实体指纹不同，避免跨账号去重
      const c = runRuleset("u2", input);
      expect(c.findings[0].fingerprint).not.toBe(a.findings[0].fingerprint);
    });

    it("reclassifyFinding：越界年份修正后复算返回 null", () => {
      const stillBad = reclassifyFinding(
        { ruleCode: "DATE_OUT_OF_RANGE", evidence: { observationDate: "2052-01-01" } },
        { minYear: 1990, maxYear: 2026 },
      );
      expect(stillBad).toEqual({ severity: "WARNING", suggestedAction: "FIX_DATE" });
      const fixed = reclassifyFinding(
        { ruleCode: "DATE_OUT_OF_RANGE", evidence: { observationDate: "2025-01-01" } },
        { minYear: 1990, maxYear: 2026 },
      );
      expect(fixed).toBeNull();
    });
  });

  describe("扫描与处置（带回滚凭据）", () => {
    async function seedBadData() {
      const user = await registerUser();
      const site = await createSite(user.id);
      const { speciesId, phenophaseId } = await createSpeciesWithPhase(user.id);

      // 非法日期 + observedAt 可兜底
      const invalidDate = await prisma.observation.create({
        data: {
          ownerId: user.id,
          siteId: site.id,
          speciesId,
          phenophaseId,
          kind: "PLANT_PHENOLOGY",
          observationDate: "2025-13-40",
          observedAt: new Date("2025-04-05T00:00:00.000Z"),
          title: "非法日期",
        },
      });

      // 缺阶段
      const missingPhase = await prisma.observation.create({
        data: {
          ownerId: user.id,
          siteId: site.id,
          speciesId,
          phenophaseId: null,
          kind: "PLANT_PHENOLOGY",
          observationDate: "2025-04-06",
          title: "缺阶段",
        },
      });

      // 孤立文件：直接往存储里写一个三档齐全但无 DB 引用的 key
      const orphanKey = "2025/04/orphan-lonely.webp";
      await Promise.all(
        (["thumb", "display", "original"] as const).map((variant) =>
          storage.put(orphanKey, Buffer.from("orphan"), variant, "image/webp"),
        ),
      );

      // 照片行三档全丢
      const missingPhoto = await prisma.observationPhoto.create({
        data: {
          observationId: invalidDate.id,
          storageKey: "2025/04/gone.webp",
          thumbKey: "2025/04/gone.webp",
          displayKey: "2025/04/gone.webp",
          originalName: "gone.jpg",
          mimeType: "image/webp",
          width: 1,
          height: 1,
          bytes: 1,
        },
      });

      return { user, site, speciesId, phenophaseId, invalidDate, missingPhase, orphanKey, missingPhoto };
    }

    async function findByRule(token: string, ruleCode: string) {
      const response = await request(app)
        .get("/api/v1/quality/findings")
        .set(auth(token))
        .query({ status: "ALL", limit: 200 });
      expect(response.status).toBe(200);
      return response.body.data.find((f: { ruleCode: string }) => f.ruleCode === ruleCode);
    }

    it("完整链路：扫描出问题 → 处置 → 回滚 → 重扫消解", async () => {
      const { user, speciesId, phenophaseId, invalidDate, missingPhase, orphanKey, missingPhoto } =
        await seedBadData();

      // 普通用户不能扫孤立文件
      const denied = await request(app)
        .post("/api/v1/quality/scan")
        .set(auth(user.accessToken))
        .send({ includeOrphanFiles: true });
      expect(denied.status).toBe(403);

      // 普通扫描（不含孤立文件）
      const scan1 = await request(app)
        .post("/api/v1/quality/scan")
        .set(auth(user.accessToken))
        .send({});
      expect(scan1.status).toBe(201);
      expect(scan1.body.data.summary.total).toBeGreaterThanOrEqual(3);

      // CLI/管理员等价路径：管理员跑全盘扫描，补出孤立文件
      await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
      const { runScan } = await import("../modules/quality/scan");
      const full = await runScan(user.id, { includeOrphanFiles: true });
      expect(full.summary.byCategory.FILE).toBeGreaterThanOrEqual(2);

      // 1) FIX_DATE：用 observedAt 兜底，然后回滚
      const invalidFinding = await findByRule(user.accessToken, "DATE_INVALID");
      expect(invalidFinding).toBeTruthy();
      const fixRes = await request(app)
        .post(`/api/v1/quality/findings/${invalidFinding.id}/actions`)
        .set(auth(user.accessToken))
        .send({ action: "FIX_DATE" });
      expect(fixRes.status).toBe(201);
      const fixActionId = fixRes.body.data.actionId;
      const afterFix = await prisma.observation.findUniqueOrThrow({ where: { id: invalidDate.id } });
      expect(afterFix.observationDate).toBe("2025-04-05");

      // 凭据里有改前快照
      const fixAction = await prisma.qualityAction.findUniqueOrThrow({ where: { id: fixActionId } });
      const fixBefore = JSON.parse(fixAction.beforeSnapshot) as { observationDate: string };
      expect(fixBefore.observationDate).toBe("2025-13-40");

      const rollbackFix = await request(app)
        .post(`/api/v1/quality/actions/${fixActionId}/rollback`)
        .set(auth(user.accessToken))
        .send({});
      expect(rollbackFix.status).toBe(200);
      const restored = await prisma.observation.findUniqueOrThrow({ where: { id: invalidDate.id } });
      expect(restored.observationDate).toBe("2025-13-40");
      // 凭据已核销，不能重复回滚
      const again = await request(app)
        .post(`/api/v1/quality/actions/${fixActionId}/rollback`)
        .set(auth(user.accessToken))
        .send({});
      expect(again.status).toBe(409);

      // 2) SET_PHENOPHASE：补齐阶段，再回滚
      await request(app)
        .post(`/api/v1/quality/findings/${(await findByRule(user.accessToken, "PHASE_MISSING_FOR_PLANT")).id}/actions`)
        .set(auth(user.accessToken))
        .send({ action: "SET_PHENOPHASE", phenophaseId });
      const afterPhase = await prisma.observation.findUniqueOrThrow({ where: { id: missingPhase.id } });
      expect(afterPhase.phenophaseId).toBe(phenophaseId);
      expect(afterPhase.speciesId).toBe(speciesId);

      // 3) QUARANTINE_FILE：孤立文件移入隔离区并可还原
      const orphanFinding = await findByRule(user.accessToken, "FILE_ORPHAN");
      expect(orphanFinding?.storageKey).toBe(orphanKey);
      const quarantineRes = await request(app)
        .post(`/api/v1/quality/findings/${orphanFinding.id}/actions`)
        .set(auth(user.accessToken))
        .send({ action: "QUARANTINE_FILE" });
      expect(quarantineRes.status).toBe(201);
      {
        const qaActionId = quarantineRes.body.data.actionId;
        await expect(storage.read(orphanKey, "thumb")).rejects.toThrow();
        const rb = await request(app)
          .post(`/api/v1/quality/actions/${qaActionId}/rollback`)
          .set(auth(user.accessToken))
          .send({});
        expect(rb.status).toBe(200);
        const buf = await storage.read(orphanKey, "thumb");
        expect(buf.toString()).toBe("orphan");
      }

      // 4) DROP_PHOTO_ROW：删除坏照片行，凭据含整行快照，回滚重新插入
      const missingFinding = await findByRule(user.accessToken, "FILE_MISSING");
      const dropRes = await request(app)
        .post(`/api/v1/quality/findings/${missingFinding.id}/actions`)
        .set(auth(user.accessToken))
        .send({ action: "DROP_PHOTO_ROW" });
      expect(dropRes.status).toBe(201);
      expect(await prisma.observationPhoto.findUnique({ where: { id: missingPhoto.id } })).toBeNull();
      await request(app)
        .post(`/api/v1/quality/actions/${dropRes.body.data.actionId}/rollback`)
        .set(auth(user.accessToken))
        .send({});
      const reinserted = await prisma.observationPhoto.findUniqueOrThrow({ where: { id: missingPhoto.id } });
      expect(reinserted.storageKey).toBe("2025/04/gone.webp");

      // 5) 修复后重新扫描：日期/阶段问题自动消解
      await request(app)
        .post(`/api/v1/quality/findings/${invalidFinding.id}/actions`)
        .set(auth(user.accessToken))
        .send({ action: "FIX_DATE", newDate: "2025-04-05" });
      await request(app)
        .post("/api/v1/quality/scan")
        .set(auth(user.accessToken))
        .send({ categories: ["DATE", "PHASE"] });
      const after = await prisma.qualityFinding.findMany({ where: { ownerId: user.id } });
      const invalidNow = after.find((f) => f.ruleCode === "DATE_INVALID");
      const phaseNow = after.find((f) => f.ruleCode === "PHASE_MISSING_FOR_PLANT");
      expect(invalidNow?.status).toBe("RESOLVED");
      expect(phaseNow?.status).toBe("RESOLVED");
    });

    it("DISMISS 后重新扫描不会自动复活，回滚忽略后才回到 OPEN", async () => {
      const { user } = await seedBadData();
      await request(app).post("/api/v1/quality/scan").set(auth(user.accessToken)).send({});
      const finding = await findByRule(user.accessToken, "PHASE_MISSING_FOR_PLANT");
      const dismiss = await request(app)
        .post(`/api/v1/quality/findings/${finding.id}/actions`)
        .set(auth(user.accessToken))
        .send({ action: "DISMISS", reason: "已知误报" });
      expect(dismiss.status).toBe(201);

      await request(app).post("/api/v1/quality/scan").set(auth(user.accessToken)).send({ categories: ["PHASE"] });
      const still = await prisma.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } });
      expect(still.status).toBe("DISMISSED");

      await request(app)
        .post(`/api/v1/quality/actions/${dismiss.body.data.actionId}/rollback`)
        .set(auth(user.accessToken))
        .send({});
      const reopened = await prisma.qualityFinding.findUniqueOrThrow({ where: { id: finding.id } });
      expect(reopened.status).toBe("OPEN");
      expect(reopened.dismissedAt).toBeNull();
    });

    it("未登录返回 401，且无法操作他人问题", async () => {
      const { user } = await seedBadData();
      await request(app).post("/api/v1/quality/scan").set(auth(user.accessToken)).send({});
      const other = await registerUser();
      const finding = await findByRule(user.accessToken, "DATE_INVALID");
      const res = await request(app)
        .post(`/api/v1/quality/findings/${finding.id}/actions`)
        .set(auth(other.accessToken))
        .send({ action: "DISMISS" });
      expect(res.status).toBe(404);
      expect((await request(app).get("/api/v1/quality/findings")).status).toBe(401);
    });
  });
});
