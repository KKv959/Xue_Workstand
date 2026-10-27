# 任务中心 API

任务中心 API 用于提交需要在后台执行的长任务，并通过轮询任务状态获取进度、结果、失败原因或取消任务。接口与当前网页同源，默认开发地址为 `http://localhost:3000`。

接口实现位于 `src/app/api/jobs/route.ts` 和 `src/app/api/jobs/[jobId]/route.ts`；创建请求与任务恢复输入共用 `src/lib/job-validation.ts` 中的 Zod schema。

## 通用约定

- 请求体使用 JSON，并应发送 `Content-Type: application/json`。
- 成功响应为 JSON；错误响应统一为 `{ "error": "中文错误信息" }`。
- 任务创建后立即返回，实际工作由后台队列执行。创建响应中的状态通常是 `queued`，随后可能变为 `running`。
- `APP_MODE=workspace` 允许所有任务类型；`APP_MODE=gross-margin` 只允许 `gross-margin-refresh`，其他类型返回 `403`。
- 任务结果因任务类型而异，不能依赖一个固定的 `result` 结构。只有详情接口会返回 `result` / `partialText`（如果任务结果已被持久化压缩，则以 `resultCompacted` 和 `resultSizeBytes` 为准）；列表接口只返回摘要。

## 接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/jobs` | 首次加载任务或按游标读取任务变更 |
| `POST` | `/api/jobs` | 创建后台任务 |
| `GET` | `/api/jobs/:jobId` | 读取单个任务详情 |
| `PATCH` | `/api/jobs/:jobId` | 停止或重试任务 |

## `GET /api/jobs`

### 查询参数

`cursor` 可选，值必须原样使用上一次响应返回的 `cursor`。它是服务端不透明游标，不要在客户端拆解或自行递增。

- 不传 `cursor`：返回最多 80 条当前任务摘要，并将 `reset` 设为 `true`。
- 传入有效且仍在变更日志窗口内的游标：只返回游标之后发生变化的任务。
- 游标过期、来自旧进程，或格式无效：服务端自动返回完整摘要，`reset` 为 `true`。
- 没有新变化时：`jobs` 和 `removedJobIds` 都为空，`reset` 为 `false`。

### 响应

```json
{
  "jobs": [
    {
      "id": "job-single-video-transcribe-1720000000000-a1b2c3d4",
      "kind": "single-video-transcribe",
      "status": "running",
      "title": "提取单条视频文案",
      "inputSummary": "示例视频",
      "scope": { "targetType": "url", "sourceKey": "b1946ac9" },
      "stage": "transcribing",
      "message": "正在转写视频",
      "progress": 42,
      "href": "/tools",
      "hasPartialText": true,
      "hasResult": false,
      "events": [],
      "createdAt": "2026-08-19T10:00:00.000Z",
      "updatedAt": "2026-08-19T10:00:12.000Z"
    }
  ],
  "removedJobIds": [],
  "cursor": "7a4f6b0e-7f2f-4c0f-9d25-000000000001.12",
  "reset": false,
  "readErrors": [],
  "recoveryErrors": {}
}
```

列表项是 `JobListItem`：不会内嵌 `partialText` 或 `result`，而是用 `hasPartialText`、`hasResult` 表示详情中是否存在对应字段。`removedJobIds` 表示客户端应从本地缓存删除的任务。

列表保留全部活跃任务，另保留最近 80 条历史；客户端合并增量响应时沿用此规则。`recoveryErrors` 按任务 ID 返回当前恢复错误，即使 `jobs` 没有增量也须同步；摘要和详情的 `recoveryError` 不写回原记录。带此字段的任务不应显示为运行中，任务中心提供重新发起入口。

`readErrors` 是读取失败的中文提示列表，客户端应显示这些提示；旧服务端可能不返回此字段，按空数组处理。单条损坏、未知类型或未来版本记录不阻断其他任务读取，详情读取仍显式报错。

任务记录和恢复载荷新增 `schemaVersion: 1`。没有该字段的旧记录仍可读，恢复载荷保留原有 `version: 1`；未来版本、无效输入或与任务类型不一致的载荷不会执行或改写原记录。合法旧任务继续沿用原恢复策略，图片任务重启后标记中断，不自动重新调用模型。兼容性检查不迁移旧文件，也不保证旧程序能读取未来新增的任务类型。

批量转写在第一条转写前保存固定候选 ID，后续恢复只处理这一批；显式 `videoIds: []` 表示空批次。已启动的旧批次若没有固定候选，会中断并提示确认范围后重新发起。每条转写结果落盘后同步递增 `dataRevision`，不必等待整个批次完成。

云端按 D1 中未到期的租约统一执行 `JOB_MAX_ACTIVE`；存活租约不会被其他实例恢复，执行器定期续租并检查取消。取消后仍占用容量直到执行器退出，租约失效的旧执行器不能覆盖新状态。未启动的云端排队任务可被其他实例接手；已启动任务仍按对应类型的恢复规则处理。

推荐的同步算法：

1. `reset=true` 时，用响应中的 `jobs` 替换本地摘要缓存。
2. 否则按 `id` 合并 `jobs`，再删除 `removedJobIds` 中的 ID。
3. 无论是否有变化，都保存新的 `cursor`，供下一次请求使用。

## `POST /api/jobs`

### 公共外层字段

```ts
type StartJobRequest = {
  kind: JobKind;
  title?: string;         // 不填时由服务端按 kind 生成
  inputSummary?: string;  // 不填时由服务端按 input 生成
  href?: string;          // 不填时使用任务对应页面
  input: object;
};
```

服务端响应：

```json
{
  "jobId": "job-single-video-transcribe-1720000000000-a1b2c3d4",
  "job": {
    "id": "job-single-video-transcribe-1720000000000-a1b2c3d4",
    "kind": "single-video-transcribe",
    "status": "queued",
    "stage": "queued",
    "message": "任务已加入队列",
    "progress": 0,
    "events": [
      {
        "at": "2026-08-19T10:00:00.000Z",
        "status": "queued",
        "stage": "queued",
        "message": "任务已加入队列",
        "progress": 0
      }
    ],
    "createdAt": "2026-08-19T10:00:00.000Z",
    "updatedAt": "2026-08-19T10:00:00.000Z"
  }
}
```

### 支持的 `kind` 与 `input`

项目风格和草稿封面任务不再接受新请求，历史记录仍兼容读取。写作仅支持账号风格，历史项目稿可查看和手动保存。下表列出 API 层的字段和约束。平台值为 `bilibili` 或 `douyin`；标为“可选”的字段可以省略。

| `kind` | `input` |
| --- | --- |
| `write-copy` | 写作或续改。必填 `mode`（`topic` / `rewrite`）；常用字段为 `action`（`create` / `revise`，默认 `create`）、`prompt`、`sourceText`、`supportDocLinks`、`targetType`、`platform`、`accountId`、`styleRefs`、`save`、`useWebResearch`。续改时还需 `parentDraftId`、`currentContent`、`revisionInstruction`；`revisionScope=selection` 时还需 `selectedText`。新稿 `topic` 必须有 `prompt`，`rewrite` 必须有改写要求或素材。 |
| `account-style` | `platform`、`accountId` |
| `transcribe-video` | `platform`、`accountId`、`videoId`；`mediaUrl`（完整 `http(s)` URL）、`allowRemoteDownload` 可选。 |
| `batch-transcribe` | `platform`、`accountId`、`limit`（正整数或 `all`，默认 `5`）；`videoIds`（数组，空数组表示不选视频）、`updateStyle` 可选。 |
| `engagement` | `sourceType` 为 `draft`、`text`、`url` 或 `record`。分别需要 `draftId`、`text`、`url` 或 `recordId`。公共选项：`includeComments` 默认 `true`、`commentCount` 1-200 默认 `50`、`includeDanmaku` 默认 `false`、`danmakuCount` 1-300 默认 `50`、`targetPlatform` 可选。评论统一先执行全网调研，不再提供生成模式切换。 |
| `hotlist-refresh` | 必填 `window`；`accountIds`（非空数组）、`limit` 1-120、`automatic` 可选。 |
| `collect-account` | `platform`、`name`、`limit` 1-50、`order`（`views` / `likes` / `favorites` / `comments` / `pubdate`）；`uidOrUrl`、`fromDate`、`toDate` 可选。 |
| `single-video-transcribe` | `url`（完整 `http(s)` URL）；`titleHint` 可选。 |
| `publish-copy` | `sourceText`；`platform`（`bilibili` / `douyin` / `both`，默认 `both`）、`topicHint`、`candidateCount` 1-10 可选。 |
| `hotspot-refresh` | 空对象 `{}`。 |
| `gross-margin-refresh` | `recordIds` 可选；传入时必须是字符串数组，不传表示刷新全部监控记录。 |

### 创建示例

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "single-video-transcribe",
    "input": {
      "url": "https://www.bilibili.com/video/BV1example",
      "titleHint": "示例视频"
    }
  }'
```

创建成功后不要阻塞等待业务结果；保存返回的 `jobId`，用详情接口或任务列表游标轮询。

## `GET /api/jobs/:jobId`

返回完整 `JobRecord`：

```json
{
  "job": {
    "id": "job-single-video-transcribe-1720000000000-a1b2c3d4",
    "kind": "single-video-transcribe",
    "status": "completed",
    "title": "提取单条视频文案",
    "stage": "done",
    "message": "视频文案提取完成",
    "progress": 100,
    "resultRef": { "href": "/tools", "label": "查看工具台" },
    "result": { "url": "https://www.bilibili.com/video/BV1example" },
    "events": [],
    "createdAt": "2026-08-19T10:00:00.000Z",
    "updatedAt": "2026-08-19T10:00:18.000Z",
    "completedAt": "2026-08-19T10:00:18.000Z"
  }
}
```

常用字段：

- `status`：`queued`、`running`、`completed`、`failed`、`interrupted`、`cancelled`。
- `progress`：0-100 的进度值；不要把它当作剩余时间估计。
- `stage`、`message`：面向用户的当前阶段和说明。
- `partialText`：部分任务在运行中产生的中间文本，仅详情接口可能返回。
- `result`：任务完成后的类型相关结果；`resultRef` 提供结果页面跳转信息。
- `error`：失败原因；`completedAt` 在任务进入终态时写入。
- `dataRevision`、`dataChange`：任务分批写入业务数据时的变更标记，客户端用于失效相关缓存。

找不到任务时返回 `404` 和 `{ "error": "找不到任务记录" }`（或对应的中文兜底信息）。

```bash
curl http://localhost:3000/api/jobs/job-single-video-transcribe-1720000000000-a1b2c3d4
```

## `PATCH /api/jobs/:jobId`

请求体只有一个字段：

```json
{ "action": "cancel" }
```

### 停止任务

`action=cancel` 会中止运行中的任务、从队列移除待执行任务，并返回状态为 `cancelled` 的任务。已完成、失败、已取消或已中断的任务不能再次停止。

### 重试任务

`action=retry` 只接受终态任务。服务端会读取原任务保存的输入并创建一个新的任务，因此响应中的 `job.id` 是新的任务 ID，不能继续轮询旧 ID。若原任务的恢复参数已被清理，会返回“任务恢复参数缺失，请重新发起”。

```bash
curl -X PATCH http://localhost:3000/api/jobs/job-abc \
  -H 'Content-Type: application/json' \
  -d '{"action":"retry"}'
```

成功响应为 `{ "job": JobRecord }`。`action` 缺失或不是 `cancel` / `retry` 时返回 `400`。

## 错误处理建议

客户端应先检查 HTTP 状态码，再读取 JSON 中的 `error` 字符串。常见情况如下：

| 状态码 | 含义 |
| --- | --- |
| `400` | JSON 无法解析，或 `kind` / `input` 未通过 Zod 校验 |
| `403` | 当前 `APP_MODE` 不允许该任务类型 |
| `404` | 任务 ID 不存在（详情接口） |
| `500` | 队列初始化、持久化或任务处理失败；具体原因优先看 `error` |

任务本身执行失败不会让创建请求返回 `500`：创建仍会成功，之后通过详情或增量列表看到 `status=failed` 和 `error`。因此轮询逻辑必须同时处理 HTTP 错误和任务终态失败。

## 相关源码

- 路由：`src/app/api/jobs/route.ts`、`src/app/api/jobs/[jobId]/route.ts`
- 类型：`src/lib/types.ts` 中的 `JobRecord`、`JobListItem`、`JobListResponse`、`JobStartInput`
- 队列与持久化：`src/lib/jobs.ts`
- 客户端封装：`src/lib/client.ts` 中的 `getJobs`、`startJob`、`getJob`、`cancelJob`、`retryJob`
