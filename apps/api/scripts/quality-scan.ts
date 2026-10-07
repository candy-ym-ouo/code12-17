/**
 * 独立数据质量体检脚本（不依赖 HTTP 服务，可直接挂 cron 定期复算）。
 *
 * 用法：
 *   pnpm --filter @nature/api quality:scan -- --email demo@nature.local
 *   pnpm --filter @nature/api quality:scan -- --email demo@nature.local \
 *     --reference-date 2026-10-07 --categories DATE_OUT_OF_RANGE,ORPHAN_FILE
 *
 * 退出码：0 = 无 CRITICAL 发现；1 = 存在 CRITICAL 发现；2 = 参数或运行错误。
 * 同一数据快照 + 同一 --reference-date 的 digest 必然一致，可用于前后两次体检比对。
 */
import { prisma } from "../src/lib/prisma";
import { runScan } from "../src/modules/quality/service";
import type { FindingCategory } from "../src/modules/quality/rules";

function parseArgs(argv: string[]): { email: string; referenceDate?: string; categories: FindingCategory[] } {
  const args = new Map<string, string>();
  const tokens = argv.filter((token) => token !== "--");
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index];
    if (key.startsWith("--")) args.set(key, tokens[index + 1] ?? "");
  }
  const email = args.get("--email");
  if (!email) {
    console.error("缺少参数：--email <用户邮箱>");
    process.exit(2);
  }
  const categories = (args.get("--categories") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) as FindingCategory[];
  return { email, referenceDate: args.get("--reference-date") || undefined, categories };
}

async function main(): Promise<void> {
  const { email, referenceDate, categories } = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`用户不存在：${email}`);
    process.exit(2);
  }

  const report = await runScan(user.id, { categories, referenceDate });
  console.log(`体检时间：${report.generatedAt}（参照日 ${report.referenceDate}，规则集 v${report.rulesetVersion}）`);
  console.log(`报告指纹：${report.digest}`);
  console.log(
    `发现 ${report.summary.total} 项：CRITICAL ${report.summary.bySeverity.CRITICAL} / ` +
      `WARNING ${report.summary.bySeverity.WARNING} / INFO ${report.summary.bySeverity.INFO}`,
  );
  for (const finding of report.findings) {
    console.log(
      `  [${finding.severity}] ${finding.ruleId} ${finding.entity.type}:${finding.entity.id} — ${finding.message}` +
        (finding.action ? `（可执行：${finding.action}）` : ""),
    );
  }
  process.exit(report.summary.bySeverity.CRITICAL > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
