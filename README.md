# 自然观察时间线（Nature Timeline）

在同一地点持续记录**树木发芽、昆虫出现、鸟鸣变化、天气异常**，用照片与文字沉淀数据，并按年份对比同一地点、同一物种、同一物候阶段的首现日。

前端 Vue 3 + Vite + TypeScript + Element Plus，后端 Node.js + Express + TypeScript + Prisma，开发用 SQLite、生产可切 PostgreSQL。

> 需求、接口、算法与验收标准见仓库根目录的 `项目文档.md`（本目录的上层）。

## 快速开始

```bash
node -v                 # 需要 >= 20.11（本仓库用 22.x 验证）
corepack enable
pnpm install

cp .env.example apps/api/.env   # 首次可跳过，仓库已带一份开发用 .env
pnpm db:deploy                  # 创建数据库并应用迁移
pnpm db:seed                    # 写入预置物种库与演示数据（生产可用 FORCE_SEED 控制）

pnpm dev                        # API: http://localhost:3000，Web: http://localhost:5173
```

验证：

```bash
curl http://localhost:3000/api/v1/healthz
curl http://localhost:3000/api/v1/readyz
pnpm --filter @nature/api smoke   # 走一遍注册→建点→导入物种→记录→对比→导出→分享
```

演示账号：`demo@nature.local` / `Nature#2025`（仅开发环境种子数据写入）。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 并行启动前后端 |
| `pnpm build` | 构建后端（tsc）与前端（vue-tsc + vite build） |
| `pnpm start` | 以生产模式启动 API |
| `pnpm db:deploy` | 应用已有迁移（部署/CI 用） |
| `pnpm db:migrate` | 开发环境生成新迁移 |
| `pnpm db:seed` | 写入预置物种与演示数据 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm db:sync-schema` | 由 SQLite schema 生成 PostgreSQL schema |
| `pnpm test` | 后端接口/算法测试 + 前端组件测试 |
| `pnpm test:coverage` | 后端覆盖率报告 |
| `pnpm test:e2e` | Playwright 端到端测试（需要数据库已迁移并 seed） |
| `pnpm --filter @nature/api smoke` | 闭环冒烟测试（需要 API 已启动） |
| `pnpm --filter @nature/api quality:scan` | 数据质量体检 CLI（全用户扫描，含孤立文件；可 `--user/--min-year/--category`） |
| `pnpm --filter @nature/api quality:recompute` | 只按当前规则集复算历史问题分级 |
| `pnpm --filter @nature/api quality:rollback <actionId>` | 凭处置凭据回滚一次处置动作 |
| `pnpm typecheck` | 两端类型检查 |

## 目录结构

```text
origin/
├─ apps/api        # Express + Prisma 后端
│  ├─ prisma/      # schema、迁移、种子
│  ├─ scripts/     # ensure-db、postgres schema 生成、冒烟测试
│  └─ src/         # config / middleware / modules / lib / tests
└─ apps/web        # Vue 3 前端
   ├─ src/api      # axios 客户端与接口封装
   ├─ src/stores   # Pinia
   ├─ src/views    # 时间线、对比、统计、地点、物种、设置、分享
   └─ tests        # 单元测试 + Playwright E2E
```

## 已实现的功能

- 账号：注册、登录、刷新令牌轮换、登出、修改资料与密码（改密后撤销其他会话）
- 地点：增删改查、归档/取消归档、使用量统计、只读分享链接（可设范围与有效期、可撤销）
- 物种：四类物种、个人库与系统预置库、一键导入预置物种及其物候阶段、阶段增删
- 观测：四类观测（发芽/昆虫/鸟鸣/天气异常）动态表单、标签、草稿与发布、重复记录拦截
- 照片：多图上传（≤9 张、单张 ≤10MB）、服务端方向纠正与三档 webp 压缩、缩略图、删除
- 时间线：年/月分组、游标分页、地点/物种/阶段/类型/年份/关键词/仅有照片/状态筛选
- 对比：按年份并排首现记录与照片，输出相对上一年与相对多年中位基准的偏移天数
- 统计：概览指标、逐年首现日折线、相对基准偏移柱状图、天气同期偏差（样本不足时明确不下结论）
- 导出：CSV（带 BOM，Excel 不乱码）与 JSON（含照片链接）
- 运维：健康检查、就绪检查、结构化日志与 traceId、限流、备份恢复说明
- 数据质量体检：扫描日期越界（非法日历日/年份越窗/observedAt 漂移）、植物物候阶段缺失、照片文件缺失与磁盘孤立文件；分级建议可复算，处置动作保留改前凭据并支持回滚

## 关键实现说明

- **日期语义**：`observationDate` 是站点当地日历日字符串，所有分组与统计只使用它；`observedAt` 仅作精度补充。
- **序日**：跨年比较统一映射到平年参照系（`dayOfYear` 使用固定平年），因此闰年 3 月及以后不会凭空多出一天，2 月 29 日与 2 月 28 日同值。
- **偏移**：`offsetVsPrevYear` 与最早的上一个可用年份比较；`offsetVsBaseline` 与该年之前所有可用年份的中位数比较，历史年份不足 2 年时返回 `INSUFFICIENT_HISTORY` 而不是 0。
- **图片**：统一解码为 webp 三档（480 / 1600 / 2560），默认剥离 GPS，保留拍摄时间。
- **存储**：内置本地磁盘适配器（`thumb/`、`display/`、`original/` + 年/月目录）；对象存储适配器预留接口，配置 `S3_BUCKET` 时服务会明确报错提示未启用，而不是静默降级。
- **时区**：默认 `Asia/Shanghai`，用户可在设置页修改，影响"今天"的判定与天气默认年份。

## 数据质量体检（可复算、可回滚）

入口：前端「数据体检」页（`/quality`）或 `pnpm --filter @nature/api quality:scan`（CLI 不依赖 HTTP 服务，且默认启用需要全盘清单的孤立文件规则）。

- **扫描规则**（规则集版本记录在每份报告 `rulesetVersion` 上）：
  - 日期：`DATE_INVALID`（非法 YYYY-MM-DD，严重）、`DATE_OUT_OF_RANGE`（超出合理年份窗口，默认 1990–次年）、`DATE_OBSERVED_AT_MISMATCH`（日历日与时间戳漂移，提示）；
  - 阶段：`PHASE_MISSING_FOR_PLANT`（植物物候记录无阶段，警告）、`PHASE_WITHOUT_SPECIES`（有阶段却无物种，警告）；
  - 文件：`FILE_MISSING`（照片元数据在、三档物理文件缺失，全丢为严重、部分丢为警告）、`FILE_ORPHAN`（磁盘有文件但无任何记录引用，三档齐全为警告，仅管理员/CLI 可触发）。
- **分级可复算**：规则是纯函数，每条问题有稳定 `fingerprint`（用户 + 规则 + 实体定位）；重新扫描会自动对账（新问题 OPEN、消失的 OPEN 置 RESOLVED、人工 DISMISSED 不复活），`POST /api/v1/quality/recompute` 可在不重扫磁盘的情况下按最新规则集刷新历史问题分级。
- **处置与回滚凭据**：每次处置先写 `QualityAction.beforeSnapshot`（改前字段 / 完整照片行 / 隔离路径），再改数据；孤立文件不硬删除而是移到 `uploads/.quarantine/<actionId>/`。`POST /api/v1/quality/actions/:id/rollback` 凭凭据原样还原，凭据核销后不可重复回滚（`ROLLED_BACK` 状态留痕）。目标观测已被删除等无法回滚的场景返回明确错误而不是静默成功。

## 生产部署（不依赖容器）

1. 准备 PostgreSQL 16 与 Node.js 22，创建数据库与账号。
2. 在 `apps/api/.env` 配置：`NODE_ENV=production`、`DATABASE_URL=postgresql://用户:密码@主机:5432/nature`、`JWT_SECRET`（至少 32 字符）、`APP_ORIGIN=https://你的域名`、`UPLOAD_DIR=/var/lib/nature/uploads`。
3. 生成 PostgreSQL schema、应用迁移并构建：

```bash
pnpm install --frozen-lockfile
pnpm db:sync-schema
DATABASE_URL="postgresql://用户:密码@主机:5432/nature" \
  pnpm exec prisma migrate deploy --schema prisma/schema.postgres.prisma
pnpm build
```

4. 启动 API（建议用 systemd 或 pm2 守护，日志走 stdout）：`pnpm --filter @nature/api start`，默认监听 3000 端口。
5. 前端产物在 `apps/web/dist`，交给任意静态服务器（Nginx、Caddy、云对象存储）托管，并把 `/api` 与 `/files` 反向代理到 API；
   SPA 需要把未知路径回退到 `index.html`，`/assets` 可设置长缓存。
6. 上线后确认 `/api/v1/healthz` 与 `/api/v1/readyz` 均返回 200。

备份与恢复：

```bash
pg_dump -U nature -h 数据库主机 nature | gzip > backup_$(date +%F).sql.gz
tar czf uploads_$(date +%F).tar.gz -C apps/api/uploads .

gunzip -c backup_2026-10-07.sql.gz | psql -U nature -h 数据库主机 nature
tar xzf uploads_2026-10-07.tar.gz -C apps/api/uploads
```

## 已知环境注意事项

- 仓库内 `.npmrc` 指向公共镜像 `registry.npmmirror.com`，因为本机全局 npm 配置指向的内网镜像不可达；如你的网络有可用私有镜像，改回即可。
- 部分 macOS 环境下 Prisma 无法自动创建 SQLite 文件（报 `Error: Schema engine error:`），`scripts/ensure-db.mjs` 会在迁移前先创建空文件，脚本已自动串联。
- Playwright E2E 默认使用本机已安装的 Chrome（`channel: chrome`）；未安装时可先执行 `pnpm exec playwright install chromium` 并调整 `playwright.config.ts`。

## 测试现状

| 层级 | 命令 | 覆盖 |
| --- | --- | --- |
| 后端单元 + 接口 | `pnpm --filter @nature/api test` | 48 项：认证、权限、重复校验、游标分页、草稿、照片、对比偏移、导出、数据质量体检（规则/处置/回滚） |
| 后端闭环冒烟 | `pnpm --filter @nature/api smoke` | 17 项：真实 HTTP 走通主链路 |
| 前端组件/状态 | `pnpm --filter @nature/web test` | 8 项：分组、筛选参数、时间线卡片、对比网格 |
| 端到端 | `pnpm --filter @nature/web test:e2e` | 桌面与移动视口：注册→建点→导入物种→记录→时间线；匿名分享 |
