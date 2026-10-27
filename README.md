# 账号风格库本地网页

本地使用的账号风格库工作台，用于把 B站 / 抖音账号的爆款内容采集、转写、沉淀成可编辑风格卡，并在写作台里参考账号风格生成文案。

## 规划文档

- [任务中心 API](./docs/api/jobs.md)：后台任务的创建、增量轮询、详情、停止与重试。
- [对话中下载与转写视频](./docs/api/dialogue-media.md)：从任意本机对话复用单条视频接口，结果仅作为本次输出，不加入业务资料库。

## 启动

```bash
npm install
cp .env.example .env
npm run dev
```

打开 `http://localhost:3000`，默认进入视频热榜页 `/douyin-hotlist`（历史路径保留）。开发服务默认使用 Turbopack，侧栏仅在鼠标停留或键盘聚焦目标模块时预热该页面，不再自动遍历全站和业务 API；离开目标或点击导航时取消预热，让真实导航优先。开发模式首次访问未编译模块仍可能需要等待编译。正式服务下侧栏按 Next.js 默认在可视区预取页面，经公网链接切页时不必再等一次网络往返。

如果希望服务退出终端后仍然保持运行，可以使用后台启动：

```bash
npm run dev:daemon
npm run dev:status
npm run dev:restart
npm run dev:stop
```

后台日志写入 `.dev-server/next-dev.log`，该目录不会提交到 git。

## 运行指标与模型评测

任务中心现在会通过 Pino 输出结构化运行日志。每次任务阶段切换会记录任务类型、阶段、平台、排队耗时、阶段耗时、模型、缓存、fallback 和失败信息，但不会记录原文、文案正文或密钥。日志级别可通过 `PINO_LOG_LEVEL` 调整，默认是 `info`。

查看已持久化任务的汇总指标：

```bash
npm run metrics:pipeline
npm run metrics:pipeline -- --json
```

评测写作链路需要先启动本地工作台，并指定一个已经有风格卡的账号目录名；评测使用 `save: false`，不会创建草稿：

```bash
PROMPTFOO_STYLE_PLATFORM=bilibili \
PROMPTFOO_STYLE_ACCOUNT_ID='已有风格卡的账号目录名' \
npm run eval:writer -- --max-concurrency 1 --no-write
```

评测样本位于 `evals/`，只应放脱敏、可复用的固定样本。Promptfoo 默认只在本地运行；不要把素材评测结果上传到 Promptfoo Cloud。修改提示词、模型或上下文组装后，先用同一批样本运行评测，再结合 `npm run metrics:pipeline` 观察真实任务的成功率和耗时。

## 本机正式服务

正式服务通过 macOS LaunchAgent 运行在 `127.0.0.1:3000`；Cloudflare Tunnel 和自定义域名由工作区外的 Caddy、`cloudflared` 配置维护（链路：`work.xjxwork.online` → Cloudflare → Caddy `127.0.0.1:3001` → `127.0.0.1:3000`）。Caddy 只给页面和 API 设置 `private, no-store`，`/_next/static/*` 沿用 Next.js 的长期缓存头，不要覆盖，否则每次打开页面都要经隧道重新确认全部 JS/CSS。公网入口目前没有登录。

```bash
npm run remote:setup      # 首次安装本机常驻服务（macOS）
npm run remote:start      # 启动当前正式版本
npm run remote:stop       # 停止正式服务
npm run remote:status     # 查看正式服务和本地健康状态
npm run remote:dev        # 切回开发服务
npm run remote:deploy     # 检查、构建、发布并健康检查
npm run remote:rollback   # 回退上一可用版本
```

常驻服务按 Next.js 生产环境优先级读取项目根目录的 `.env.production.local`、
`.env.local`、`.env.production`、`.env`（进程已有环境变量优先），支持 `$变量名` 引用。
修改模型或联网检索配置后，执行 `npm run remote:start` 重启当前正式版本即可生效。

日常开发可执行 `npm run remote:dev`，代码修改自动更新，无需逐次发布。桌面侧栏底部的“服务模式”按钮也可切换开发服务或上次发布的正式服务；仅在 Mac 本机 `localhost:3000` 页面可操作，有运行或排队任务时拒绝切换。按钮切到正式服务不会重新构建或发布代码，正式版须先通过 `remote:deploy` 更新。隔离测试服务不能控制本机服务。

发布前若存在运行或排队任务会直接拒绝。正式产物保存在 `.remote-server/releases/<buildId>`，保留最近两个版本；启动失败会自动恢复上一版。正式服务始终读取当前项目的真实 `style-library`，不会创建第二份可写数据。服务通过 `caffeinate` 在 Mac 插电、开盖时保持运行。

如果要把“数据维护”和“数据监控”单独交付给 Windows 用户，使用专用发行模式：

```bash
npm run package:release -- --preset gross-margin-win
```

这个专用包不是单文件 `exe`，而是 Windows 便携包：解压后先运行一次 `setup-browser-bridge.cmd` 安装/启用 OpenCLI 浏览器扩展，再双击 `start.cmd`，浏览器默认打开 `/gross-margin`，并且只保留“数据维护”和“数据监控”两页；其他工作台页面在专用模式下会被自动拦回毛利模块。专用包会内置 `opencli` 主程序，目标 Windows 机器不需要再单独安装全局 opencli；B站 / 抖音实时刷新仍需要 Chrome / Edge 里的 OpenCLI Browser Bridge 扩展连通。

开发服务器运行时不要同时执行 `npm run build`，Next.js 会复用 `.next` 目录，可能让开发页的 CSS/JS 静态资源短暂 404。若页面看起来像样式丢失，执行：

```bash
rm -rf .next
npm run dev
```

## 已移除的隐藏功能

项目工作台、项目写作和草稿封面生成已移除，相关页面、API 和新任务入口不再提供。账号写作、生图工作台、评论生成与毛利模块继续保留。经用户授权，旧项目、项目稿件及专用素材已通过资料库事务移入可恢复回收站，项目专属模型设置已清理。存储层仍兼容回收站恢复后的历史记录；服务重启时，未完成的项目风格或草稿封面任务会明确中断。

## Pi 模型与中转站兜底

文字生成、风格分析、评论弹幕、提示词辅助、热点分析和图片理解优先读取 Pi 保存的全局默认模型。使用已锁定的 Pi 1.1.0；工作站只调用模型，不加载编码工具、项目指令、扩展或技能。

在本机工作站的 `/ai-settings` 页面连接 ChatGPT 订阅，按页面链接完成浏览器授权，再选择默认模型与推理强度并保存。授权回调使用本机 `127.0.0.1:1455`；订阅配置和高级设置的写入仅允许本机同源页面，远程页面可查看状态但不能发起登录或保存。Pi 凭证保存在本机，不会返回网页。实际可用模型和额度由订阅服务响应决定。

```bash
npm run pi
```

在 Pi 中运行 `/login` 登录服务商或订阅账号；运行 `/model` 选择模型，按 `Ctrl+S` 保存为默认；在 `/thinking` 中选择推理强度，同样按 `Ctrl+S` 保存默认。仅切换当前会话而未保存的选择不会影响工作站。新请求读取最新的全局配置，无需重启。订阅可用模型和额度以 Pi 登录结果及实际服务响应为准。

配置默认位于 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 指定其他目录。工作站与终端必须使用相同操作系统用户及该目录。不要把 `auth.json` 或访问令牌放进仓库、网页或发布包。

Pi 支持在该目录的 `models.json` 配置中转站，例如下面的配置（请换成服务商真实接口与型号）：

```json
{
  "providers": {
    "my-relay": {
      "baseUrl": "https://relay.example.com/v1",
      "api": "openai-completions",
      "apiKey": "${MY_RELAY_API_KEY}",
      "models": [{ "id": "your-model-id", "reasoning": true, "input": ["text", "image"] }]
    }
  }
}
```

终端与工作站进程都需要能够读取该环境变量；支持 Responses 的中转站可用 `openai-responses`。配置参数遵循 [Pi 官方模型说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。现有中转站作为兜底时无需搬进 Pi：原有 `CHAT_*`、`CHAT_FALLBACK_*` 与历史链路覆盖设置保持可用，也不会把 Pi 订阅凭证传给中转站。

Pi 没有默认模型、登录失效、额度不足、限流或请求失败且尚未收到正文时，切换原中转站链路并记录中文兜底原因。已收到部分正文后不追加另一模型的输出，也不保存为完整稿件；取消不触发兜底。设 `PI_ENABLED=0` 可完全退回原模型链路。

`/ai-settings` 提供 Pi 订阅登录与默认模型选择；“高级设置”按业务环节保存调用来源（自动 / 仅订阅 / 仅中转）、中转模型和推理强度，写入 `settings/ai-models.json`，旧中转站兜底也读取该文件。联网检索继续走明确支持 `web_search` 的 Responses 节点；生图与火山 ASR 继续使用原专用接口。

## 配置

- `OPENCLI_BIN`：默认使用 `opencli`，用于 B站 / 抖音采集。
- `OPENCLI_BROWSER_CONNECT_TIMEOUT`：opencli 等待 Browser Bridge 连接的秒数，Windows 专用包默认 `8`，避免扩展未连接时每条刷新长时间卡住。
- `OPENCLI_WINDOW`：opencli 浏览器窗口模式，Windows 专用包默认 `background`，减少刷新时反复弹出浏览器窗口。
- `OPENCLI_BROWSER_SESSION`：手动浏览器采集统一复用的后台会话名，默认 `content-workbench-browser`；不要为每次任务生成新名称，否则 Chrome 会累积多个 “OpenCLI Browser” 分组。会话空闲 30 秒后自动释放（标签页留作空白占位、复用同一分组），B站 / 抖音等站点适配器每次调用后即释放，避免 Chrome 常驻“已开始调试此浏览器”提示条。
- `OPENCLI_PROFILE`：可选。多个 Chrome profile 同时连接 Browser Bridge 时，用 `opencli profile list` 中的别名或 contextId 固定到一个 profile。
- `GROSS_MARGIN_MONITOR_REFRESH_CONCURRENCY`：数据监控刷新并发数，默认 `6`，允许 `1-6`；B站优先并发读取公开统计接口，仅在公开接口失败时进入 OpenCLI 兜底。
- `FFMPEG_BIN`：默认使用 `ffmpeg`，抖音和无字幕 B站回退转写时会先抽取音频。
- `STYLE_LIBRARY_DIR`：本地风格库目录，默认 `./style-library`。
- `WECOM_ACCOUNT_SHEET_URL`：可选。配置企业微信在线表格链接后，数据维护里的抖音 / B站账号配对和报价以在线表为准，通过 `wecom-cli` 读取。普通打开会立即展示最后一次成功缓存并在后台刷新，不再等待远端；手动点击刷新才会等待最新结果。在线表暂时不可用时继续显示上次成功缓存或本地缓存，并给出可见警告。
- `WECOM_PROJECT_SHEET_URL`：可选，覆盖数据维护使用的“自孵化 - 短视频一口价锁档及执行情况”项目表。按上海时区当月工作表、平台和账号匹配项目；链接唯一匹配或只有一个项目时自动选择，多项目可切换。折前价格取下单金额，返点比例为返点金额除以下单金额，折后价格直接取最终合作价格。页面只读取按来源和年月保存的成功缓存；进入页面、缓存过期或新月份无缓存时均不自动同步，点击项目右侧刷新按钮才同步。同步使用任务中心，支持停止和重试；缺失或无效金额显式提示，远端失败保留成功缓存。
- `WECOM_CLI_BIN`、`WECOM_ACCOUNT_SHEET_CACHE_TTL_MS`、`WECOM_ACCOUNT_SHEET_FALLBACK_LOCAL`：在线账号表读取命令、缓存时长和本地回退开关。后台同步失败后普通读取冷却 5 分钟，手动刷新可立即重试；非法报价或缓存落盘失败不会覆盖最后成功数据。回退关闭时读取显式报错。
- `JOB_MAX_ACTIVE`：后台任务最大同时运行数，默认 `5`，允许 `1-6`；多任务会先排队再执行。
- `JOB_HISTORY_LIMIT`：任务历史保留条数，默认 `200`，允许 `50-1000`，超出后自动清理更早的已结束任务。
- `JOB_HISTORY_MAX_MB`：任务历史磁盘预算，默认 `20MB`，允许 `5-500MB`；和条数上限任一先到即清理更早的已结束任务。
- `JOB_RESULT_PERSIST_KB`：已有独立落盘资产的终态任务结果压缩阈值，默认 `96KB`，允许 `16-1024KB`；未保存草稿、单视频提取、发布文案和图片提示词结果完整保留，避免重启丢失唯一结果。
- `VOLCENGINE_ASR_API_KEY`：火山引擎录音文件识别 2.0 API Key。
- `VOLCENGINE_ASR_RESOURCE_ID`：火山引擎转写资源 ID，默认 `volc.seedasr.auc`。
- `VOLCENGINE_ASR_POLL_INTERVAL_MS`：火山转写查询间隔，默认 `1000` 毫秒。
- `VOLCENGINE_ASR_MAX_POLL_ATTEMPTS`：火山转写最大轮询次数，默认 `120`。
- `VOLCENGINE_ASR_REQUEST_TIMEOUT_MS`：火山转写单次请求超时，默认 `30000` 毫秒。
- `VOLCENGINE_ASR_RETRY_COUNT`：火山转写遇到瞬时网络错误时的重试次数，默认 `2`，建议保持在 `0-3`。
- `DOUYIN_TRANSCRIBE_CONCURRENCY`：抖音批量转写并发数，默认 `3`，建议保持在 `1-4`。
- `DOUYIN_HOTLIST_REFRESH_CONCURRENCY`：视频热榜账号刷新并发数，默认 `2`，允许 `1-5`；抖音使用共享会话内的有界并发，每六个账号返回后保存结果并更新进度，分页间隔 `250ms`。变量名沿用旧版抖音热榜配置。
- `CHAT_API_KEY`、`CHAT_BASE_URL`、`CHAT_RESPONSES_URL`、`CHAT_COMPLETIONS_URL`、`CHAT_MODEL`、`CHAT_WIRE_API`、`CHAT_REASONING_EFFORT`、`CHAT_SERVICE_TIER`：主对话模型配置，用于自动提炼风格和生成文案。新中转站如果只兼容 OpenAI Chat Completions，可设 `CHAT_WIRE_API=chat_completions`；不确定时可设 `CHAT_WIRE_API=auto`，系统会在 Responses 不兼容时自动切到 Chat Completions。`CHAT_SERVICE_TIER=priority` 可显式请求中转站 / Codex 的快速服务层，和 `xhigh` 推理档位是两件事。`CHAT_BASE_URL` 可以填中转站根地址，也可以用 `CHAT_RESPONSES_URL` / `CHAT_COMPLETIONS_URL` 指定完整接口地址。`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 也会作为主模型配置读取。
- `CHAT_FALLBACK_API_KEY`、`CHAT_FALLBACK_BASE_URL`、`CHAT_FALLBACK_RESPONSES_URL`、`CHAT_FALLBACK_COMPLETIONS_URL`、`CHAT_FALLBACK_MODEL`、`CHAT_FALLBACK_WIRE_API`、`CHAT_FALLBACK_REASONING_EFFORT`、`CHAT_FALLBACK_SERVICE_TIER`、`CHAT_FALLBACK_PROXY_URL`、`CHAT_FALLBACK_ENABLED`：第一备用对话模型配置。默认配置为 `https://www.fhl.mom` / `gpt-6.1-sol` / `responses` / `xhigh`，但必须单独填写 `CHAT_FALLBACK_API_KEY` 或 `FHL_API_KEY` 才会启用，避免把主模型 key 发到旧中转站。还可按相同后缀配置 `CHAT_FALLBACK_2_*` 至 `CHAT_FALLBACK_5_*`，系统会依次尝试。
- `CHAT_PROXY_URL`：可选。若 Node/Next 直连模型服务失败，可设为本机代理，例如 `http://127.0.0.1:7890`。
- `BILIBILI_HTTP_PROXY`：可选，仅用于 B站公开详情、评论和短链接的后台 HTTP 请求。Node 不自动跟随 macOS 系统代理；直连超时时可填写已验证的本机 HTTP 代理（如 `http://127.0.0.1:7890`）。留空保持直连，浏览器抓取逻辑不变。
- 本机模型请求按代理地址复用连接池，空闲连接默认保留 30 秒（服务端 keep-alive 提示优先），最多保留 8 个代理池；淘汰时等待在途请求结束。直连继续使用 Undici 默认连接池，云端继续使用原生 fetch。此优化减少重复建连，不改变模型、推理强度或重试策略。
- `CHAT_HEALTH_PROBE_TIMEOUT_MS`：对话模型健康检查探针超时，默认 `8000` 毫秒，允许 `2000-30000`。
- `WEB_RESEARCH_ENABLED`、`WEB_RESEARCH_API_KEY`、`WEB_RESEARCH_BASE_URL`、`WEB_RESEARCH_RESPONSES_URL`、`WEB_RESEARCH_MODEL`、`WEB_RESEARCH_REASONING_EFFORT`、`WEB_RESEARCH_SERVICE_TIER`、`WEB_RESEARCH_PROXY_URL`：写作台联网检索的独立 Responses API 配置，推理档位默认 `low`（实际搜索仍服从高级设置覆盖）。它只负责 `web_search`，不会改变现有 Chat Completions 写作链；未配置独立接口时，系统仍可使用对话模型链里明确支持 Responses 的节点。密钥不会自动跨服务复用，如确实是同一服务，可在本地环境文件写 `WEB_RESEARCH_API_KEY=$CHAT_API_KEY`。
- 风格学习直接从几篇原文一次生成风格卡，不再逐篇调用模型。旧的 `STYLE_SAMPLE_ANALYSIS_CONCURRENCY`、`STYLE_ONE_SHOT_MAX_INPUT_CHARS` 不再生效。
- `ENGAGEMENT_MODEL_CONCURRENCY`：仅用于弹幕生成的历史并发配置，评论按目标数量整组生成并直接保存，不再按该值并发拆批。
- `IMAGE_API_KEY`、`IMAGE_BASE_URL`、`IMAGE_MODEL`、`IMAGE_SIZE`、`IMAGE_QUALITY`、`IMAGE_FORMAT`、`IMAGE_PROXY_URL`：可选。用于生图工作台。接口兼容 OpenAI Images API；`IMAGE_BASE_URL` 应包含 `/v1`，`IMAGE_MODEL` 填服务商提供的准确模型标识。工作台按页面选择的模型配置、尺寸和质量生成。
- `LARK_CLI_BIN`：默认 `lark-cli`，直接调用飞书 CLI（OpenCLI 2 不再转发外部 CLI）。
- `FEISHU_OPENCLI_AS`、`FEISHU_FOLDER_TOKEN`：可选。飞书文档发布固定使用 `lark-cli docs +create`，默认使用当前 lark-cli 用户身份。

风格学习、写作、评论和弹幕生成依赖可用的对话模型；调用失败不会用本地模板代替。风格卡归纳沿用现有流式模型、取消和错误处理，正常完成且引用校验通过后才保存。失败保留原卡，更新前将旧版归档到 `.style-history/`，并校验生成期间是否有人编辑。业务请求不设置统一输出 token 上限，仍受模型容量、超时和用户要求约束。

账号风格的链路是：**几篇原稿 → 一次提炼风格 → 新素材直接成稿**。本地从最多 8 篇可用转写中去重、间隔选取最多 3 篇供归纳，不做主题评分或逐篇分析。过长原文保留头、中、尾连续片段，省略处明确标注；每篇学习原文最多 6000 字符。提示词只提炼口吻、观察角度、节奏和句间衔接，不写固定套路或禁用清单。卡片原句引用仍逐字核验。旧分析缓存保留，但新链路不读写它；“账号样本分析”模型项作为历史配置保留，归纳统一用“账号风格卡”。

已有卡片不会自动重建。用户主动重新归纳时，不把旧卡规则输入模型；明确保存的偏好独立保留。原文、选样版本、提示词或模型配置改变使卡片缓存失效；无变化时复用成功卡片，备用模型信息仍保留。详细实现与对照记录见 [账号风格链路](./docs/style-writing.md)。

账号库位于 `/library`，支持按平台、转写和风格状态筛选账号，并按标题、转写状态及数据指标筛选排序视频；筛选条件和当前选择会写入 URL，刷新后可恢复。批量模式可对当前筛选结果选择、转写或导出。手动保存、重新转写和历史恢复都使用 revision 冲突保护；覆盖前的旧稿归档到账号目录的 `transcripts/.history/<video-id>/`，可在转写稿编辑器中查看并恢复。

对话写作页位于 `/writer`。参考风格支持同时选择多个账号；多选后会按每张风格卡并发生成一篇互不混合的独立文案，并分别保存为草稿，可在结果区直接切换。单篇草稿只保存自身使用的风格引用，后续模型续改和手动编辑都会沿用该稿风格并保存为同一写作会话下的新版本，不会覆盖上一版；历史列表只加载标题、版本和时间，点开后才读取草稿全文。旧草稿继续兼容读取。素材、原文、抖音 / B站视频链接和支持文档共用一个输入框：视频链接自动转写，飞书、网易灵犀、企业微信、腾讯文档及普通公开网页链接自动读取正文；一次最多读取 4 份支持文档，超限会明确报错；同一支持文档成功读取后会缓存 24 小时，并发生成时只读取一次共享资料，任一文档读取失败会停止本次生成且不会缓存失败内容；链接未公开或当前工具身份无权限时会明确报错，不会把裸链接交给模型猜。首稿只读取风格卡、本次要求与素材，不再读取或选取原作；本地准备不调用模型，随后一次生成全文。不再自动提取禁词、字数规则或追加成稿检查。新稿保存当时的风格快照，续改复用它，不重新转写、抓文档、联网或选样。续改支持“按要求微调”与“重新校准风格”，选中段落时两种方式均只调整选中范围；普通续改与校准均只使用快照中已有的原作，不重新采集或选样。旧稿缺少快照会明确说明使用当前关联卡，并从该版开始保存快照。续改以本轮指令为准，不机械套用首稿的字数检查。联网检索开关位于生成按钮旁，使用独立 `WEB_RESEARCH_*` Responses API，和现有 Chat Completions 写作接口互不影响；没有独立配置且对话模型链里也没有 Responses 节点时，入口才会置灰。选中稿件段落后可以只改局部，但模型仍会返回并保存完整新稿。多稿续改使用写作台的后台任务接口；普通和流式写作接口会明确拒绝多稿续改，避免只修改第一篇。

联网检索链路为：本次要求、素材与支持文档 → 一次 Responses `web_search` 补充资料 → 带来源的简短文本 → 写作模型。已有素材作为上下文，不逐项审查；信息够用即结束，不为填满缺项反复搜索。没有独立规划、按对象分组排队、二次摘要或 `facts` / `notes` JSON 校验。检索提示不要求核实清单、免责声明或写作建议，模型保留明显矛盾和有来源的具体信息。

写作联网阶段共用 60 秒上限，包含缓存等待、连接、搜索与重试，不包含正文生成。请求输出预算 5000 token（含推理），沿用用户保存的模型和推理设置；当前中转节点不支持 `max_tool_calls`，不发送此参数。完整结束、实际调用搜索工具、非空输出仍须满足；超时、断流、取消及外部错误明确失败，不把半截结果当成功。

完整结果在 `.cache/writer-research` 缓存 30 分钟，相同输入并发合并；只换风格卡可复用资料，续改沿用父稿资料。提示词、输入或模型配置变化后重新检索，不删除旧缓存。缓存损坏显式报错，写入沿用锁和原子写入。旧稿显式标记的检索记录块仍在写作上下文中隔离，不删除素材或成稿中的真实不确定性。

最多两次 HTTP 请求，共享 60 秒截止时间；剩余至少 20 秒才尝试下一次。瞬时故障可重试一次非流式请求，参数、鉴权、额度和限流不在同节点重试。每 10 秒显示真实阶段和已用时间。60 秒是等待上限，不是所有主题必然搜索成功的保证。

参考 [Vane（原 Perplexica）的 speed 模式](https://github.com/ItzCrazyKns/Vane/blob/master/src/lib/agents/search/researcher/index.ts) 的聚焦搜索和资料与写作分离，复用本仓库模型与存储，没有新增依赖。详见 [写作联网检索](./docs/api/writer-research.md)。

写作首稿与续改的单次流式请求默认最多等待 300 秒，其他模型请求默认 120 秒；显式配置 `CHAT_REQUEST_TIMEOUT_MS` 时两者均遵从配置值（允许 10,000–300,000 毫秒）。无正文的临时故障仍只在同一节点自动重试一次；已经输出的半篇不会拼接重试结果或作为完整草稿保存。所有等待和重试均可取消。生产服务使用独立发布产物，源码修复通过 `npm run remote:deploy` 发布后才生效。

写作联网使用上述 60 秒总预算；其他业务调用的独立 `webSearchCompleteStrict()` 仍保留 180 秒预算。`model.web-research-stream` 记录响应头、首个数据块、首个有效事件、首次搜索工具事件耗时及完整结束状态，`model.web-research-fast` 记录写作联网总耗时和资料长度。不记录素材正文或凭据。

写作素材支持点选或拖入 TXT、Markdown、CSV、JSON、HTML、字幕、DOCX 和 PDF 文件；PDF 会提取其中的文字层，扫描件请先进行 OCR。本地文件正文中的链接会保留为正文，不会误触发视频转写或支持文档抓取。

评论生成页位于 /assets，可基于已保存草稿、粘贴文案或 B站 / 抖音视频链接生成观众评论；历史区只读取摘要，点开记录后加载评论、弹幕与来源全文。粘贴文案必须选择目标平台，视频链接会自动识别。输入只要包含支持的视频链接（包括整段分享文案），就先沿用视频转写链路取得正文；链接、域名、短链码、视频 ID 与分享指令只用于采集追踪，不能进入最终评论。

评论默认生成 50 条：一次理解完整正文并规划最多两个检索词 → 同时从抖音与 B站采集 → 本地排除明显灌水来源，按来源轮转选择原话（参考 JSON 最多 12,000 字符，目标平台优先；不设 80 条或每视频 20 条限制）→ 基于当前完整正文优先复用原评、不足再补写 → 直接保存。生成后的 AI 审核和本地内容筛选均已停用。优先直接复用符合正文的原评；不执行原评 AI 复核、逐条迁移审核或零命中重规划。历史原评资产保留，新链路不追加原评库。

每个平台先搜索全部规划词，再合并视频候选、排除输入视频并去重，只选评论总数超过 200 条的视频（不含 200 条）；搜索未提供真实计数时查询详情，计数未知或不足时跳过，不降低门槛。兼顾不同检索方向和作者，依据平台搜索名次选样，热度作为次要比较。两平台先各尝试两个视频，以合计 600 条跨来源去重原评为目标；不足时继续使用已有搜索候选，每平台最多尝试四个视频，总计最多八个。每视频以 200 条为目标，接口明确结束时可少于 200 条；少量有效评论也保留。达到总目标后不再启动额外候选，首批和已经发出的请求仍完成，因此结果可能超过 600 条。候选不足或访问受限时明确显示实际数量与覆盖不足，不重复规划或无限扩大搜索。分页记录保留每页游标、返回量、新增量和继续标记，视频记录标明达到目标、接口到底或失败；空页仍有后续、游标异常和达到分页上限不能伪装成采集完成。采集样本、来源、参考样本、实际参考字符数和耗时随调研缓存保存。参考保留来源标题及原句，按长短与高低赞轮转取样；单条超过参考预算八分之一时跳过整条，不截成摘要。

生成接收标题（含话题标签）和完整正文，参考视频标题只解释原评语境，不作为当前视频事实。评论首轮按目标数量整组生成，解析非空字符串并按请求条数截取后直接保存；不进行重复、长度、表情、链接、语境或事实筛选，不清洗或改写评论，不超采样，不启动两个上下文相同的生成批次。数量不足时只补一次缺口，复用正文、参考和已生成评论，不重跑规划与采集；仍不足会保存可用结果并明确报错。用户之后主动重试可以再开放一轮补缺口。模型输出的重复和内容问题由生成提示词控制，最终结果不再获得审核保证。

当前提示词版本为 `engagement-v14-douyin-session`：根据正文和抓取的评论生成指定数量，优先直接复用符合正文的原评，保留原话，不够再补写。不设复用比例或额外审核。

表达参考和整组生成结果按阶段原子落盘。任务中心重试与取消后重试沿用检查点，成功阶段不重做；仅生成评论的任务在服务重启后自动续跑，包含弹幕的任务仍需手动重试。输入、模型或提示词配置改变时使用新检查点，损坏检查点显式报错。同一检查点的最终记录使用稳定 ID，避免恢复时重复保存。评论规划和生成会在 `engagement/.cache/model-calls` 保存真实消息、响应、模型、推理档位、重试和墙钟耗时；不保存密钥、接口地址或请求头。检查点中的历史 `review` 字段兼容保留，新链路用它记录已保存结果，不代表调用 AI 审核。

整次生成不设置固定停止计时；保留外部接口单次请求超时、有界网络重试、一次空内容 / 格式纠正和用户取消。采集部分失败显示来源与原因，没有真实样本则停止。模型失败不使用本地模板凑数。新结果统一标记“AI 生成”；历史“相关原评”、审核诊断和旧模型设置仍兼容读取。结果页展示精选表达参考及采集情况；原评审核、重规划和最终审核节点不再出现在模型设置中。Word 导出沿用已有格式与命名。

弹幕仍保留独立的真实节奏参考，仅支持 B站；运行 npm run engagement:refresh-style 可刷新弹幕标杆数据。火山转写取得语音分段时使用真实时间，否则结果区明确显示“文案节奏估时”。

工具台位于 `/tools`，提供单条视频文案提取、视频 / 封面 / 音频下载，以及标题和发布文案生成。

账号采集、工具台的单条提文案 / 标题文案、热点雷达刷新、视频热榜刷新和毛利批量刷新都通过任务中心后台运行，可查看进度并停止。任务输入与状态会持久化，前端使用游标只拉取增量变化；服务重启后，批量转写、热榜刷新、热点刷新和毛利刷新等幂等任务会自动回到队列，其他失败或中断任务可在任务中心直接重试。账号、视频、项目、素材、草稿和监控记录的删除会进入 `style-library/.trash/`，跨文件引用清理失败时自动回滚，也可通过 `/api/library/trash` 查询和恢复；浏览器文件下载仍采用直接流式下载。

抖音账号名采集会调用 `opencli douyin search <账号名> -f json` 解析 `sec_uid`；如果本机 opencli 暂未提供该适配器，可以先填写抖音主页链接或 `sec_uid` 采集。

视频热榜页位于 `/douyin-hotlist`（历史路径保留）。它维护一个独立的本地对标账号池，可添加抖音或 B站账号；关注列表保存在 `style-library/douyin-hotlist/watchlist.json`，账号和抓取结果保存在 `style-library/douyin-hotlist/accounts/<account>/`；这里添加账号不会写入主账号库 `style-library/douyin/` 或 `style-library/bilibili/`。抓取通过任务中心在后台运行，可查看账号级进度或停止任务；页面打开且可见时每 3 小时自动刷新一次，关闭页面不会抓取。自动刷新按最近一次全量检查计时，单账号手动抓取不会推迟全量刷新。

读取热榜不会创建目录、迁移主账号库视频或重写关注列表。旧版 `douyin:` 引用会明确提示需显式迁移；已有独立热榜账号的目录保持不变，新账号按平台与 UID 区分，同名账号不会覆盖。

抖音热榜通过 OpenCLI 后台共享会话批量读取作品接口：每轮只初始化一次抖音会话，不逐账号打开主页。发布时间和互动统计使用接口真实字段，不从作品 ID 推测日期；批量媒体地址预取仍使用 `opencli douyin user-videos`。遇到 HTTP `401` / `403` / `444` / `429` 时暂停尚未发出的抖音请求，保留已成功结果与已有数据，并在刷新日志中提示处理方式；完成浏览器验证或等待限流恢复后可再次刷新。

抖音单链接素材读取与单条媒体地址刷新使用 `opencli douyin detail`，直接按作品链接或 ID 取得标题、作者、封面和视频地址；返回的作品 ID 必须匹配，图文作品或缺少有效视频地址会显式报错。抖音转写优先复用已采集的媒体地址，必要时调用 `detail` 刷新单条地址，然后由本机 `ffmpeg` 抽取 16kHz 单声道低码率 mp3，并通过火山引擎录音文件识别 2.0 的 `audio.data` 提交转写，避免火山服务端直接拉取带防盗链的抖音 URL。批量转写抖音视频时会先按账号预取一次媒体地址，再使用小并发转写，以减少重复 opencli 查询和火山任务排队带来的等待；如果本机网络、opencli、ffmpeg 或火山接口限流不稳定，可把 `DOUYIN_TRANSCRIBE_CONCURRENCY` 调回 `1`。B站视频仍优先使用公开字幕，没有字幕时会尝试下载后抽音频转写。

开发验证可依次运行 `npm test`、`npm run lint`、`npm run typecheck` 和 `npm run check:library`。若一致性检查只报告可安全推导的转写元数据漂移，可在确认后运行 `npm run check:library:repair`；修复前的原文件会备份到 `style-library/.repairs/<timestamp>/`，孤立目录、损坏 JSON 和跨引用问题不会自动修改。

## 打包交付

生成可交付运行包：

```bash
npm run package:release
```

如果要生成“数据维护 / 数据监控”Windows 专用便携包：

```bash
WINDOWS_NODE_DIR=/path/to/windows-node npm run package:release -- --preset gross-margin-win
```

如果要生成给普通 Windows 用户双击安装的 `.exe` 安装包，优先使用 GitHub Actions 里的
`Build Gross Margin Windows Installer` 工作流。它会在 Windows runner 上安装 Inno Setup，
并执行：

```bash
npm run package:release -- --preset gross-margin-win-installer
```

安装包会把程序装到用户目录下，并创建桌面/开始菜单快捷方式；运行数据保存在用户
`AppData`，升级安装不会覆盖已有维护和监控数据。本机 macOS 仍可继续生成 `.zip`
便携包用于排查，但不建议在 macOS 上直接生成 `.exe`。

脚本会在临时目录安装依赖并构建 Next.js standalone 产物，输出到 `dist/`：

- `account-style-library-*.tar.gz`：macOS / Linux 交付压缩包。
- `account-style-library-*.zip`：Windows 优先使用这个压缩包。
- `account-style-library-*-setup.exe`：Windows 安装包，优先交付给什么都没装的用户。
- 同名目录：本机可直接测试的解压目录。

`--preset gross-margin-win` 只生成 Windows `.zip` 和对应目录，不再生成 macOS / Linux `.tar.gz`。打包前需要通过 `WINDOWS_NODE_DIR` 提供一个包含 `node.exe` 的 Windows Node 运行时目录，脚本会把它内置到运行包里。

默认不会把本机 `style-library` 打进包里，避免误发账号素材、转写稿、草稿和监控记录。对方首次启动后会在运行包内创建空的 `style-library`。如果确实要带当前本地数据一起交付，显式执行：

```bash
npm run package:release -- --include-library
```

`--preset gross-margin-win` 固定只复制毛利数据，不会把整个 `style-library` 打进包里，避免误发其他账号库、草稿和写作素材。打包时只允许显式 `GROSS_MARGIN_LIBRARY_SOURCE` 或当前仓库 `style-library/gross-margin` 作为毛利数据源；找不到数据源会直接失败。如果确实要生成空毛利包，追加 `--allow-empty-gross-margin`。

对方解压后：

- macOS 双击 `install-deps.command` 检查/安装 Node.js、opencli、ffmpeg，再双击 `start.command`。
- 终端运行 `./install-deps.sh`、`./start.sh`、`./stop.sh`。
- Windows 先完整解压 `.zip`，首次使用运行 `setup-browser-bridge.cmd`，确认 OpenCLI Browser Bridge 扩展连通后再运行 `start.cmd`、`stop.cmd`；不要在压缩包预览窗口里直接双击。`gross-margin-win` 专用包会优先使用包内 `node.exe`，目标机不需要先全局安装 Node 或 opencli。

数据维护 / 数据监控模块不需要大模型；专用包已内置 `opencli` 主程序以支持刷新平台数据，但浏览器型抓取需要 Browser Bridge 扩展，无字幕视频转写才需要 `ffmpeg` 和火山转写配置。

默认写作只读取风格卡，不再选取原作或制定计划。`writer.preparation` 日志记录素材、支持文档、联网和风格准备耗时，不记录资料正文。


### 直接写作与可撤销偏好

选博主并提供素材后，每种风格通常只调用一次模型直接成稿。提示词只要求参考作者的口吻与节奏、讲清本次素材，用户当次要求优先，其次是明确保存的偏好。字数和形式由用户要求决定，不再自动提取禁词、制定计划或生成检查清单。作者原文只在提炼风格卡时读取。支持文档和联网资料仅在实际提供或启用时加入，视频转写或联网可能有额外调用。单篇展示生成中的正文，多篇独立生成。

在成稿下填写“以后也这样写”，点击“记住这条偏好”，只更新当前稿件对应的一个博主。偏好独立标注为用户表达要求，不视为博主原作证据；它对之后的新稿生效，旧稿续改仍用原快照。可撤销本次记住，或在风格卡中编辑清理。更新复用现有原子写入、风格历史和 hash 冲突校验；重新学习保留明确保存的偏好。普通手改和 AI 输出不会自动升级为长期规则。本版没有后台自动采集，也不批量重建旧风格卡。

## 生图工作台

工作台模式下打开 `/images`，或从侧栏进入“生图工作台”。创作画布支持拖动、平移、缩放与分支查看；作品图库用大缩略图纵向浏览历史。底部常驻提示词、模型、比例和张数（默认 1 张），右侧“参数设置”提供质量、精确尺寸与 2K / 4K 预设。最多使用 6 张参考图（上传、拖放、粘贴，每张最多 10MB）；在提示词中输入 `@` 可引用已上传素材或当前画布的生成图，引用绑定图片 ID，提交时转换为模型接收的图片序号。移除仍被引用的图片后，需删除对应引用或重新添加图片才能生成。

查看历史不会替换当前输入；“复用这组参数”显式载入历史设置，“基于此图修改”将该结果作为参考创建新分支，保留旧记录。可选 2–4 张图片并排对比，也支持缩放预览和原图下载。画布归属与分支随生成记录保存，拖动位置仅保存在当前浏览器；旧记录按独立画布展示，无需迁移。页面使用 React Flow、Tiptap Mention 和 Yet Another React Lightbox，模型密钥不下发到浏览器。

生图复用任务中心的排队、进度、取消和失败重试。结果逐张原子保存到 `STYLE_LIBRARY_DIR/images`，部分失败或取消保留已完成图片；服务重启后未完成任务标记为中断，可手动重试，不自动重复调用收费图片服务。再次生成创建独立记录，原图和原参数保持不变。历史列表返回摘要，图片按需读取。

请在 `.env.local` 配置 `IMAGE_API_KEY`、`IMAGE_BASE_URL`、`IMAGE_MODEL`；运行中的生产服务需重启以读取新配置。接口参数是否被接受取决于中转服务；拒绝、限流、鉴权失败和超时均显示真实错误，不生成替代图片。毛利专用模式不开放本模块。

生图工作台支持模型配置选择、自定义宽高（256–4096）、16 倍数对齐和常用比例 / 2K / 4K 预设。尺寸是否可用由对应图片服务决定。新增服务使用 `.env.local` 的 `IMAGE_PROFILES` JSON 数组，例如 `[{"id":"provider2","label":"第二套服务","model":"模型名","baseUrl":"https://example.com/v1","apiKey":"服务密钥"}]`。每套配置有独立密钥和地址，页面只接收名称与 ID；原 `IMAGE_*` 配置保留为 `default`，`IMAGE_DEFAULT_PROFILE` 可指定新建任务默认选择的配置 ID。历史记录保留所选配置 ID，旧记录继续使用默认配置；修改配置后重启服务生效。

本机订阅生图：在 AI 模型配置连接「ChatGPT 订阅（Codex）」，将「图片生成」来源保存为「仅订阅」，重新打开生图工作台。该路径通过 Pi 调用 Codex 的 `image_generation` 工具，支持参考图、逐张保存和取消，使用订阅额度；不依赖 OpenAI 直连资格，不自动切换中转。中转型号覆盖仅对「仅中转」生效。图片记录保留实际来源。

### 游戏热点雷达

资讯发现沿用本机 NewsNow v0.0.41。右上角刷新最多并发请求 4 个来源，覆盖全部卡片（含隐藏的来源）；来源失败时保留旧内容并显示失败原因。卡片可拖拽排序、隐藏与恢复，偏好仅保存在当前浏览器。对固定镜像应用交互层：`node --import tsx scripts/install-newsnow-workbench.mjs --apply`。脚本先校验镜像，备份部署代码，再重建 NewsNow 容器，不删除数据卷；升级镜像前需要更新适配器。

`/hotspots` 默认打开 TrendRadar 原生报告。工作台使用本机 Docker 容器 `workbench-trendradar`（可由 `TRENDRADAR_CONTAINER` 覆盖），直接执行已安装 [TrendRadar](https://github.com/sansan0/TrendRadar) 引擎的采集、筛选、排名统计、AI 分析与 HTML 报告生成；当前适配验证版本为 6.10.0。旧工作台的粗筛 → 事件归并 → 精筛 → 五档选题卡链路已退出后台任务入口，旧文件保留，不自动迁移或删除。NewsNow 仍可在“资讯发现”浏览。

使用方法：选择“全天汇总 / 当前榜单 / 增量更新”，选择 AI 兴趣筛选或已配置关键词，填写关注方向后点击“采集并生成报告”。全天汇总使用当天累积数据，当前榜单查看本轮榜单，增量更新查看首次发现的资讯。生成过程接入任务中心，支持进度、取消和重启中断后的重试；成功后原子保存报告及原生分类状态，失败保留上次成功报告。没有匹配资讯时原生引擎可能不执行 AI 分析，页面明确提示。

AI 兴趣筛选沿用 TrendRadar 的标签提取、相关度分类、兴趣变更处理和去重缓存；关键词模式沿用部署中的 `frequency_words.txt`。模型请求通过工作台统一模型配置与备用节点执行，不向容器传递模型密钥。原生报告包含按标签/来源分组的资讯、原文链接、排名及时间信息，并输出五个分析板块：核心热点与舆情态势、舆论风向与争议、异动与弱信号、RSS 深度洞察、研判与策略建议。RSS 与排名轨迹分析启用，原生默认分析上限由容器配置决定。舆情属于基于资讯的模型判断，不是实测评论情绪。

容器配置位于 `~/Applications/trendradar/config`；除了 `config.yaml`、`frequency_words.txt`，须有官方 `ai_analysis_prompt.txt` 与 `ai_filter/{prompt,extract_prompt,update_tags_prompt}.txt`。工作台在容器临时目录运行，读取当天上游数据库的 SQLite 一致性副本，后续沿用工作台已保存的原生数据库状态；仅采集配置内来源，不读取工作台抖音/B站视频热榜。上游每 30 分钟的独立采集继续运行，手动生成报告也会执行原生采集。工作台报告保存于资料库 `hotspots/trendradar-native.json`，不会覆盖容器原有报告或旧选题文件。

与上游的集成边界：工作台明确展示采集异常与备用模型状态；AI 筛选或分析失败直接报错，不静默退回关键词或原始模型文本。标题翻译沿用容器中的 `ai_translation` 设置与官方提示词，翻译失败显式报错；报告分析使用中文。工作台只生成本地报告，不调用原生通知渠道发送消息。默认发行包不附带 TrendRadar 引擎，需另行安装官方容器及配置。

旧 `/api/hotspots/trendradar` 只读候选接口仍可通过 `TRENDRADAR_OUTPUT_DIR` 读取上游数据库，`127.0.0.1:8081` 仍是独立容器的报告页，不是工作台控制 API。工作台新报告可在页面阅读或独立打开。
