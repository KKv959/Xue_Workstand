# 移除 Sites 与 Tailscale 代码 Implementation Plan

> 执行记录：已完成源码清理、隔离验证和本机正式版发布。外网域名探测仍受连接重置 / HTTP 403 限制，未确认公网端到端访问。

**Goal:** 删除仓库内 Sites 云端运行链、能力桥和 Tailscale 入口支持，同时保持本地工作台与 Cloudflare Tunnel 自定义域名不变。

**Architecture:** 将运行时收敛为本地 Node.js 文件系统、CLI 和模型链；移除云端分支而不是保留永远关闭的环境变量开关。`remote-server` 只负责本地正式服务发布/回滚，Cloudflare Tunnel 与 Caddy 位于仓库外，不改动。

**Tech Stack:** Next.js 15、TypeScript、Node.js、npm lockfile、现有测试套件。

**Spec:** `docs/superpowers/specs/2026-10-15-remove-sites-tailscale-design.md`

## Global Constraints

- 保留本地 Next.js、`style-library`、业务 API、任务中心和 `remote:*` 正式服务。
- 不修改 `~/.cloudflared`、Caddyfile、Cloudflare Tunnel LaunchAgent 或 `work.xjxwork.online`。
- 不读取或注入 `SITES_*`、Tailscale 或能力桥环境变量。
- 不删除用户资料库或业务资产。

## Review Focus

- 本地文件读写和任务落盘仍走原子写入与资料库校验。
- OpenCLI、FFmpeg、飞书、企业微信和 Pi 在本地模式仍走原有实现。
- 生产发布脚本仍能停止、启动、健康检查和回滚正式版本。
- 删除能力桥路由后 middleware、健康检查和客户端不会引用失效路径。
- Cloudflare Tunnel 外部守护进程和自定义域名不受仓库清理影响。

---

### Task 1: 收敛本地运行时

**Files:**
- Modify: `src/lib/storage/fs.ts`, `src/lib/jobs.ts`, `src/lib/pi-runtime.ts`, `src/lib/model-runtime.ts`
- Modify: `src/lib/opencli-runtime.ts`, `src/lib/material-analysis.ts`, `src/lib/transcription.ts`, `src/lib/wecom-account-source.ts`
- Modify: `src/lib/support-documents.ts`, `src/lib/feishu.ts`, `src/lib/remote-status.ts`, `src/app/api/health/route.ts`
- Delete: `src/lib/storage/cloud-fs.ts`, `src/lib/jobs-cloud.ts`, `src/lib/remote-capabilities.ts`, `src/lib/pi-runtime-cloud.ts`, `src/lib/capability-bridge.ts`, `src/lib/workspace-bridge.ts`

- [x] Remove cloud-mode branches and imports while preserving each local code path and existing error behavior.
- [x] Remove cloud job lease/runtime logic from `jobs.ts`, retaining local queue, persistence, cancellation, recovery, and task API contracts.
- [x] Make health/status checks report local storage and local CLI/model services only.
- [x] Run `npm run typecheck` and the affected local tests; fix import and type regressions before continuing.

### Task 2: Remove bridge routes and Tailscale process integration

**Files:**
- Delete: `src/app/api/capability-bridge/`
- Modify: `middleware.ts`, `scripts/dev-server.mjs`, `scripts/remote-server.mjs`, `src/components/RemoteStatusProvider.tsx`
- Delete: `scripts/capability-bridge-service.mjs`, `scripts/capability-bridge-gateway.mjs`, `scripts/capability-bridge-gateway.d.mts`

- [x] Remove capability-bridge middleware exceptions and route imports.
- [x] Keep `dev-server` and `remote-server` local process lifecycle, but remove token/keychain, gateway, Funnel, Serve setup and Tailscale status handling.
- [x] Keep local health checks and release switching; update messages so they do not mention Tailscale.
- [x] Run the remote lifecycle and route tests that remain applicable.

### Task 3: Remove Sites build/config surface

**Files:**
- Delete: `vite.config.ts`, `scripts/build-sites.mjs`, `scripts/prepare-sites-output.mjs`, `scripts/prepare-sites-library-migration.mjs`, `scripts/check-sites-compatibility.mjs`, `scripts/check-sites-release.mjs`
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `.env.example`, `DOCKER.md`
- Delete: `.openai/hosting.json`

- [x] Remove Sites/Vinext/Cloudflare Worker scripts and dependencies from package manifests, then regenerate the lockfile.
- [x] Remove Sites-only TypeScript paths/types and environment variables.
- [x] Preserve the local Next.js build configuration and all external Cloudflare Tunnel files outside the repository.
- [x] Run `npm ci` or the repository-approved dependency install and `npm run build` in an isolated build directory.

### Task 4: Remove obsolete docs and tests

**Files:**
- Delete: `docs/sites-cloud-cutover.md`, `docs/sites-cloud-migration.md`, `MOBILE_REMOTE_DESIGN.md`
- Modify: `README.md`
- Delete: Sites/bridge/Tailscale-only tests such as `tests/sites-cloud-capabilities.test.ts`, `tests/sites-build-isolation.test.ts`, `tests/capability-bridge*.test.ts`, `tests/dev-capability-lifecycle.test.ts`, `tests/workspace-bridge.test.ts`, `tests/model-cloud-transport.test.ts`
- Modify: remaining tests that only clear `SITES_*` variables or import removed cloud modules.

- [x] Remove obsolete setup commands and remote URLs from user-facing docs.
- [x] Keep documentation for local development, formal release, and Cloudflare Tunnel custom-domain operation.
- [x] Run `rg` to ensure no production code, scripts, docs, tests, or package manifests retain Sites/Tailscale/bridge entry points.

### Task 5: Full verification and runtime safety check

**Files:**
- Modify only if verification exposes a regression in Tasks 1–4.

- [x] Run `git diff --check` and review the deletion set for unrelated files.
- [x] Run `npm run lint`, `npm run typecheck`, targeted tests, and the full `npm test` if targeted checks pass.
- [x] Run isolated `npm run build` without touching the running `.next` directory.
- [x] Check local `/api/remote/status` and `/api/health` remain healthy.
- [x] Check `cloudflared` and Caddy processes/configuration are unchanged and the custom-domain upstream remains `127.0.0.1:3000`.


## 验证结果

- 隔离资料库全量测试：334 项，332 通过、2 项 Docker 集成检查跳过，0 失败。最初未隔离运行时图片助手测试读到了本机模型设置；改用临时 `STYLE_LIBRARY_DIR` 后通过，未修改用户设置。
- 恢复毛利模式本地任务限制断言后，目标文件 12 项全部通过；新增本机服务首次安装 / 已有版本启动测试通过。
- lint、typecheck、`git diff --check` 和隔离正式构建通过；只读资料库检查 `issues: []`。构建保留原有热点页面 CSS 的 autoprefixer 提示。
- 浏览器使用 `.dev-sandbox/library`：手机首页、更多页、写作导航、任务中心打开 / Escape 关闭通过，无控制台错误；三个已移除能力桥 API 返回 404。
- 正式版本：`20261015060432-6eb8deb-dirty-a58ad3b9`。本机 3000 与 Caddy 3001 均返回 HTTP 200，状态与存储均为 ok；临时验证服务已停止。
- Caddy / cloudflared 进程保持运行（PID 1135 / 1147），外部配置未修改；域名仍为 `work.xjxwork.online`，Tunnel 指向 3001、Caddy 指向 3000。公网请求出现连接重置或 403，无法确认端到端可用。
- 旧 Worker 本地缓存只读检查无业务记录、无对象文件后清除；未删除或迁移 `style-library` 内任何用户资产。
