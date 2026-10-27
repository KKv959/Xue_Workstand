# 移除 Sites 与 Tailscale 代码设计

## 目标

彻底移除仓库内 Sites 云端运行链、Sites 专用能力桥和 Tailscale Serve/Funnel 入口支持，同时保持本地 Next.js 工作台、正式/开发服务、`style-library` 资料库、业务 API、Caddy、Cloudflare Tunnel 和 `work.xjxwork.online` 不受影响。

## 边界

保留：

- 本地 Next.js 页面、API、任务中心、模型、OpenCLI、FFmpeg、飞书/企业微信和本地资料库。
- `remote-server` 的本地正式/开发服务管理、LaunchAgent、健康检查和发布回滚。
- `cloudflared`、Caddy 及其位于用户目录的 Cloudflare Tunnel 配置；不修改 `~/.cloudflared`、Caddyfile、Cloudflare Tunnel LaunchAgent 或自定义域名。

移除：

- Sites Worker/Vinext/Cloudflare 构建与发布脚本、依赖、项目绑定和 Sites 专用环境变量。
- Sites 云存储、云任务、云模型运行时和能力桥 API/网关。
- Tailscale Serve/Funnel 配置、检测、能力桥公开地址和移动端 Tailscale 入口文档。
- 只验证上述已移除能力的测试与文档。

## 兼容性规则

- 本地运行时不得再读取或注入 `SITES_*`、Tailscale 或能力桥环境变量。
- 本地 API 不得因为移除云端适配而改变现有请求/响应契约。
- `middleware` 不再为能力桥保留特殊放行路径。
- `package.json` 中保留本地 `dev`、`start`、`remote:*`、`build`、`lint`、`typecheck`、`test` 等脚本；删除 Sites 专用脚本。
- 不删除 Cloudflare Tunnel 的外部守护进程、配置或域名入口。

## 验证

- `rg` 确认生产代码、脚本和配置不再包含 Sites/Tailscale/能力桥运行入口；保留的历史说明需明确标记为已移除或一并删除。
- `npm run lint`、`npm run typecheck`、相关本地测试和 `npm run build` 通过。
- 正式服务健康检查通过，Cloudflare Tunnel 进程与 Caddy 仍运行，本地 `3000` 和 `work.xjxwork.online` 的后端探测不因清理而改变。
