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
| `pnpm --filter @nature/api quality:scan` | 独立数据质量体检（不依赖 HTTP，可挂 cron；`-- --email 用户邮箱 [--reference-date YYYY-MM-DD]`） |
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
- 数据质量体检：扫描日期越界、阶段缺失、孤立文件，输出分级建议（可复算），处置动作保留回滚凭据
- 运维：健康检查、就绪检查、结构化日志与 traceId、限流、备份恢复说明

## 关键实现说明

- **日期语义**：`observationDate` 是站点当地日历日字符串，所有分组与统计只使用它；`observedAt` 仅作精度补充。
- **序日**：跨年比较统一映射到平年参照系（`dayOfYear` 使用固定平年），因此闰年 3 月及以后不会凭空多出一天，2 月 29 日与 2 月 28 日同值。
- **偏移**：`offsetVsPrevYear` 与最早的上一个可用年份比较；`offsetVsBaseline` 与该年之前所有可用年份的中位数比较，历史年份不足 2 年时返回 `INSUFFICIENT_HISTORY` 而不是 0。
- **图片**：统一解码为 webp 三档（480 / 1600 / 2560），默认剥离 GPS，保留拍摄时间。
- **存储**：内置本地磁盘适配器（`thumb/`、`display/`、`original/` + 年/月目录）；对象存储适配器预留接口，配置 `S3_BUCKET` 时服务会明确报错提示未启用，而不是静默降级。
- **时区**：默认 `Asia/Shanghai`，用户可在设置页修改，影响"今天"的判定与天气默认年份。

## 数据质量体检

`apps/api/src/modules/quality` 提供历史坏数据的扫描、分级、处置与回滚能力，规则引擎为纯函数（`rules.ts`），与数据库、文件系统解耦。

**三类检查（10 条规则，CRITICAL / WARNING / INFO 三级）**

- 日期越界：非法日期、晚于参照日、早于 1900 年、早于地点创建时间、observedAt 与 observationDate 偏差过大
- 阶段缺失：已发布物候记录缺阶段（草稿不标记）、阶段与物种不匹配、物种未配置任何阶段
- 孤立文件：磁盘文件无任何记录引用（全库比对，不误伤他人文件）、照片记录缺磁盘文件（全部缺失才可移除记录）

**可复算**：同一数据快照 + 同一 `referenceDate` + 同一规则集版本，产出的发现列表与报告 `digest` 完全一致。每条发现的指纹为 `sha256(规则版本|规则|实体)` 前 16 位，处置与回滚后重扫指纹不变，可跨次比对。

**接口**（均需登录，数据按当前用户隔离；文件扫描为全库范围）

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/quality/scan?categories=&referenceDate=` | 体检报告：摘要、分级规则命中数、发现列表（含处置建议） |
| `POST /api/v1/quality/actions` | 按指纹执行处置：`quarantine_files`（隔离孤儿文件）、`clear_phenophase`（清空错配阶段）、`drop_photo_record`（移除丢失照片记录） |
| `GET /api/v1/quality/actions` / `GET /api/v1/quality/actions/:actionId` | 处置历史与凭据详情 |
| `POST /api/v1/quality/actions/:actionId/rollback` | 按凭据回滚（文件移回、字段恢复、整行重建；冲突时跳过并说明） |

**回滚凭据**：每次处置在执行前复算当前状态（指纹对不上的一律跳过），然后把撤销所需的全部信息（文件原位置、字段原值、整行快照）写入 `uploads/.quality/actions/<actionId>.json`，随上传目录一起备份即可；隔离文件存放在 `uploads/.quality/quarantine/<actionId>/`，不会被 `/files` 路由暴露。

**独立运行**：`pnpm --filter @nature/api quality:scan -- --email demo@nature.local`，存在 CRITICAL 发现时退出码为 1，适合接入巡检告警。

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
| 后端单元 + 接口 | `pnpm --filter @nature/api test` | 51 项：认证、权限、重复校验、游标分页、草稿、照片、对比偏移、导出、数据质量体检 |
| 后端闭环冒烟 | `pnpm --filter @nature/api smoke` | 17 项：真实 HTTP 走通主链路 |
| 前端组件/状态 | `pnpm --filter @nature/web test` | 8 项：分组、筛选参数、时间线卡片、对比网格 |
| 端到端 | `pnpm --filter @nature/web test:e2e` | 桌面与移动视口：注册→建点→导入物种→记录→时间线；匿名分享 |
