#!/usr/bin/env tsx
/**
 * 数据质量体检 · 独立脚本（不依赖 HTTP 服务在线）
 *
 * 用法：
 *   pnpm --filter @nature/api quality:scan                  # 全量扫描所有用户（含孤立文件）
 *   pnpm --filter @nature/api quality:scan --user <email>   # 只扫某个用户
 *   pnpm --filter @nature/api quality:scan --min-year 2000 --max-year 2026
 *   pnpm --filter @nature/api quality:scan --category DATE,PHASE
 *   pnpm --filter @nature/api quality:recompute             # 只复算分级建议，不做新扫描
 *   pnpm --filter @nature/api quality:rollback <actionId>   # 凭处置凭据回滚
 *
 * 脚本直连数据库与本地存储，因此 FILE_ORPHAN 规则（需要全盘文件清单）在此默认可用。
 * 所有写操作仍然经过 modules/quality 的同一套服务逻辑，凭据与 HTTP 调用完全一致。
 */
import { prisma } from "../src/lib/prisma";
import { runScan, recomputeFindings } from "../src/modules/quality/scan";
import { rollbackAction } from "../src/modules/quality/actions";

interface CliArgs {
  command: string;
  user?: string;
  minYear?: number;
  maxYear?: number;
  categories?: Array<"DATE" | "PHASE" | "FILE">;
  actionId?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const first = argv[0];
  const command = first === "recompute" || first === "rollback" ? first : "scan";
  const args: CliArgs = { command };
  const rest = command === "scan" ? argv : argv.slice(1);

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--user") args.user = rest[++i];
    else if (token === "--min-year") args.minYear = Number(rest[++i]);
    else if (token === "--max-year") args.maxYear = Number(rest[++i]);
    else if (token === "--category") {
      args.categories = String(rest[++i])
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean) as Array<"DATE" | "PHASE" | "FILE">;
    } else if (command === "rollback" && !token.startsWith("--")) {
      args.actionId = token;
    }
  }
  return args;
}

async function resolveUserIds(email?: string): Promise<Array<{ id: string; email: string }>> {
  if (email) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) throw new Error(`找不到用户：${email}`);
    return [user];
  }
  return prisma.user.findMany({ select: { id: true, email: true }, orderBy: { createdAt: "asc" } });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "rollback") {
    if (!args.actionId) throw new Error("用法：quality:rollback <actionId>");
    // CLI 回滚不做 owner 校验：操作者本身就是数据库运维角色，凭据里已留痕。
    const action = await prisma.qualityAction.findUniqueOrThrow({ where: { id: args.actionId } });
    const result = await rollbackAction(action.ownerId, args.actionId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "recompute") {
    const users = await resolveUserIds(args.user);
    for (const user of users) {
      const result = await recomputeFindings(user.id);
      console.log(`[${user.email}] 复算完成，分级/建议发生变化的问题：${result.recomputed}`);
    }
    return;
  }

  const users = await resolveUserIds(args.user);
  if (!users.length) {
    console.log("系统中没有用户，跳过。");
    return;
  }

  for (const user of users) {
    const result = await runScan(user.id, {
      includeOrphanFiles: true,
      ...(args.minYear !== undefined ? { minYear: args.minYear } : {}),
      ...(args.maxYear !== undefined ? { maxYear: args.maxYear } : {}),
      ...(args.categories ? { categories: args.categories } : {}),
    });
    const s = result.summary;
    console.log(
      `[${user.email}] 报告 ${result.reportId}：共 ${s.total} 条问题` +
        `（严重 ${s.bySeverity.CRITICAL} / 警告 ${s.bySeverity.WARNING} / 提示 ${s.bySeverity.INFO}）` +
        `｜日期 ${s.byCategory.DATE}、阶段 ${s.byCategory.PHASE}、文件 ${s.byCategory.FILE}` +
        `｜扫描观测 ${s.observationsScanned}、照片 ${s.photosScanned}、磁盘文件 ${s.filesScanned}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
