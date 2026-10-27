# AGENTS.md

适用于整个仓库；子目录 `AGENTS.md` 只在其作用域内覆盖冲突条款。**MUST** 必须遵守；**SHOULD** 为默认做法，偏离时说明理由并验证。只写稳定、跨模块、难以从源码看出的高风险规则；实现细节以当前源码和运行证据为准，预期行为按下述文档分工判断。

## 文档分工

`AGENTS.md` 管怎样安全地改仓库；`PRODUCT.md` 管为谁做、取舍原则；`DESIGN.md` 管界面与交互；`README.md` 管启动、配置、发布；`docs/api/` 是接口契约；`docs/superpowers/`、`.superpowers/` 是历史记录，不是现行规则。

冲突时依次服从：用户当次指令 > 本文件 > `PRODUCT.md` > `DESIGN.md` > 其他文档。判断当前实现时以源码和运行证据为准；判断预期行为时以用户当次要求和适用的产品、接口契约为准。二者不一致时先判断是实现缺陷还是文档过时，再修正当前任务涉及的部分；不得仅为迎合现有实现而修改需求、削弱测试或重写契约。

## 交付说明

沿用全局沟通偏好。交付代码改动时说明改动结果、实际执行的检查，以及影响验收的未验证项或风险。没有实质风险时不固定添加风险段落。这些格式要求不写进文档、代码或提交信息。

## 工作方式

- 仓库操作前先看 `git status --short`。工作树常有他人未提交改动：不回滚、覆盖、重排或格式化无关改动；必须改已改动的文件时，先读 diff 再叠加。
- 按任务读取相关依据：产品行为查 `PRODUCT.md`，界面与交互查 `DESIGN.md`，接口改动查 `docs/api/`，启动与发布查 `README.md`。先定位相关实现和测试，不因文档存在就通读全部资料；历史计划不作为现行需求或执行授权。
- 故障先用复现、日志或测试缩小范围，再验证最可能的原因并做最小修复。改共享逻辑前查调用方，按实际影响同步类型、测试、配置和导出；不顺带重构、加依赖或扩功能。

## MUST：用户资产

本地数据在 `STYLE_LIBRARY_DIR`（默认 `./style-library`），很多无法重建。

- `style.md`、转写稿、草稿、`*.assets`、互动历史、毛利数据：未经明确授权不得删除、迁移、批量重写、重新生成或打包外发。
- 删除走现有可恢复删除 / 事务机制并同步跨引用；不绕过锁、不直接递归删目录。
- 写入复用 `writeJsonFile` / `writeTextFileAtomic` / `writeFileAtomic` 或现有事务（临时文件 + `rename`）。路径段一律经 `normalizeStorageSegment` 等 normalize 函数，不拼接 URL、标题或用户输入。
- 持久化记录保留 `schemaVersion`，读取经 `src/lib/storage/schemas.ts` 校验。只有首次初始化的可选文件可视为空；其余缺失、损坏、越界、写入失败都要显式报错。
- 转写覆盖 / 恢复用 per-video 串行锁 + revision 校验，保留 `transcripts/.history/<video-id>/`，冲突返回 409；重新转写失败时旧稿保持可用。
- 草稿资产用 `updateDraftAssets()` / `withDraftAssetsLock()`；watchlist、身份映射等共享文件复用已有锁。同一资产的读改写不得改成 `Promise.all()`。
- `npm run check:library:repair` 只在用户同意后对真实库运行；脚本写入 `.repairs/` 的备份只覆盖它改动的文件，不替代整库备份。
- 发行包默认不含 `style-library`，仅用户要求时加 `--include-library`；毛利包只带毛利数据源，缺失即失败（仅用户要求空包时加 `--allow-empty-gross-margin`）。

## MUST：错误与外部能力

- 外部能力（opencli、ffmpeg、火山、模型、图片模型、飞书、企业微信、本地文件）失败时给可操作的中文错误；不加空 catch、假成功或模板兜底。可忽略的清理失败要注释说明。
- fallback 显式返回或持久化 `fallback` / `fallbackReason`；模型失败就失败，不用本地通用文案顶替。
- OpenCLI 走 `src/lib/opencli-runtime.ts`（`execFile` + 参数数组 + timeout / `AbortSignal`），不拼 shell 字符串。
- 模型和备用节点走 `src/lib/model-runtime.ts`；联网检索只发给支持 Responses `web_search` 的节点。
- 支持文档走 `src/lib/support-documents.ts`，正文读取失败显式失败。
- 长任务接入 `src/lib/jobs.ts` 任务中心（进度、取消、中断恢复、持久化），不用 `after()` 或未等待的 Promise。

## MUST：API、服务与公网入口

- 改前端可见 API 时同步类型、`src/lib/client.ts`、缓存失效、页面状态和错误展示。
- 改 `APP_MODE` 或 `APP_START_PATH` 时同步检查 `middleware.ts`、`AppModeGuard`、`AppNav`、任务类型限制、README、`.env.example`、`scripts/package-release.mjs`。
- 发布、回滚、切换正式 / 开发服务只在用户明确要求时执行。开发服务运行时不在同一 `.next` 上 `npm run build`，用隔离目录构建。
- 公网入口 `work.xjxwork.online` 没有登录，任何人都能调用全部 API。服务切换、模型授权、读写密钥或系统配置的接口必须限本机同源访问（复用 `isLocalServiceRequest()` 或 `isLocalSameOriginRequest()`）；破坏性接口不用 GET。
- 工作区外的网关配置（`~/.config/xjxwork-public/`、`~/.cloudflared/`、`~/Library/LaunchAgents/com.xjxwork.*`）只在用户明确要求时修改，改前留带日期的备份。网关不得覆盖 `/_next/static/*` 的缓存头。

## 业务规则

- **MUST** 视频热榜账号存于 `douyin-hotlist/accounts`，不写入主账号库；刷新走后台任务 + watchlist 锁。
- **MUST** B站统计经 `/api/videos/hydrate` 二次补全，改列表 / 详情不得绕过。
- **MUST** 写作台多选风格卡时每卡独立成稿、只存自身风格引用，续改沿用该稿风格；首稿、续改、手动编辑构成不可变版本链。`originalSourceInput` 存输入框原貌供恢复，模型用解析后的 `input` / `sourceDigest`。
- **MUST** 评论 / 弹幕输入含视频链接时先取文稿；链接标识不进 Brief 或成稿；真实平台样本缺失时显式失败。
- **SHOULD** 多卡生成有界并发；续改复用父稿资料，不重复转写、抓文档或联网。批量转写先筛待转写项再限量。评论 / 弹幕部分成功按现有机制补齐；毛利在线账号表优先返回最后成功缓存并后台刷新。

## SHOULD：实现约定

- API 路由复用 `apiJson()` / `apiError()` / `parseJsonBody()` + `zod`；NDJSON 复用 `createNdjsonStream()` / `readNdjsonStream()`，保持 `stage/delta/result/error/done` 语义并传递取消信号。
- 任务分批落盘时递增 `dataRevision` 并写 `dataChange`。
- 缓存失效与重新请求分开：页面不消费的资源只失效、不重拉。

## SHOULD：前端

- `DESIGN.md` 是视觉与交互的唯一来源；复用 token、primitives、`16-workbench-system.css` 和现有组件，不建第二套组件 / 状态 / 动效系统。路由专属样式与页面共置。
- 导航、刷新、关闭页面一律不弹离页确认（`beforeunload` 只可用于静默保存，不得拦截离开）；手动保存区域不得宣称自动保存。
- 列表 API 和 `getLibraryOverview()` 只返回摘要，重字段按 ID 懒加载；长列表分页或虚拟化，可恢复的筛选 / 排序 / 选择状态写入 URL。
- 按公网慢链路（每请求 0.5–2 秒）设计，规则见 `DESIGN.md`「慢网络下的体验」。窗口聚焦等高频事件不触发重型检查或整页重拉；性能优化以测量为依据。

## 验证

按风险选适用项，通过即停，不重复跑已覆盖的检查。

| 改动 | 检查 |
| --- | --- |
| 纯文档 | `git diff --check` + 审 diff；规则类文档核对其他文档没有矛盾 |
| 代码逻辑 | 目标测试 + 相关 lint；跨域或底层改动补 `npm test` |
| 类型 / 接口 / 依赖 | `npm run typecheck` |
| 存储结构 / 删除 / 引用 | `npm run check:library`（不跑 repair） |
| 路由结构、SSR、middleware、运行时配置、打包 | 隔离 `npm run build` |
| 前端交互 / 视觉 | 最小浏览器 smoke test；视觉改动加桌面与 390×844 截图 |
| 网关、缓存头、请求数量 | 经公网链接实测 |

写业务数据的测试和浏览器验证必须用隔离资料库（临时 `STYLE_LIBRARY_DIR` 或 `npm run dev:sandbox`），并确认服务实际用了该配置。无关的既有失败如实报告，不扩大修复范围。
