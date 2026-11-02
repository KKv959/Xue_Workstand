# 存储模块

业务数据根目录由 `STYLE_LIBRARY_DIR` 决定，默认 `./style-library`。风格卡、转写、草稿、素材、互动历史和毛利数据可能无法重建；操作范围遵循根目录 `AGENTS.md`，本说明只记录存储契约。

## 写入与读取

- 复用 `fs.ts` 的 `writeJsonFile()`、`writeTextFileAtomic()`、`writeFileAtomic()` 或现有事务，采用同目录临时文件加 rename。路径段经 `core.ts` 的 `normalizeStorageSegment()` 等对应 normalize 函数校验，不直接拼接 URL、标题或用户输入。
- 记录写入保留 `schemaVersion`，通过 `schemas.ts` 校验并保留既有旧版本兼容。只有首次初始化的可选文件可按空处理；必需文件缺失、损坏、越界、写入失败显式报错，不把异常当作空库覆盖。
- 同一资产的读改写沿用串行锁；原子替换不替代并发控制。草稿素材用 `../storage.ts` 的 `updateDraftAssets()` / `withDraftAssetsLock()`，账号身份映射和视频更新沿用各自的 mutation lock，热榜 watchlist 使用 `douyin-hotlist.ts` 的锁；不把同一资产的读改写拆成并行操作。

## 历史与恢复

- 转写覆盖、手动编辑和恢复沿用 per-video 锁及 expected revision 校验，冲突返回 409；旧正文保存于 `transcripts/.history/<video-id>/`。重新转写失败保留旧稿可用，不把旧稿标为失败。
- 删除使用 `transactions.ts` 的可恢复事务并同步跨引用，失败回滚，结果进入 `.trash/`；不直接递归删除业务目录。
- `npm run check:library` 只读检查结构和引用。`npm run check:library:repair` 会修改可推导的转写元数据，将本次改动前的文件备份至 `.repairs/<timestamp>/`；它不是整库备份，不修复孤立目录、损坏 JSON 或跨引用问题。运行范围和风险仍按任务目标判断。

## 验证入口

写入验证使用临时 `STYLE_LIBRARY_DIR` 并核对 `libraryRoot()`；浏览器验证可用 `npm run dev:sandbox`。按涉及的行为选择已有测试，不需要每次运行全部：

- `tests/storage-foundation.test.ts`：记录版本、路径与独立草稿保存。
- `tests/reliability.test.ts`：并发 revision、跨引用删除与事务失败恢复。
- `tests/hotlist-storage-safety.test.ts`：独立热榜账号、watchlist 串行更新及损坏处理。
- `tests/collection-transcription-safety.test.ts`：转写冲突不破坏旧稿；`tests/foundation.test.ts`：转写与统计并发、repair 备份。

写作版本和资料快照的业务语义见 [账号风格链路](../../../docs/style-writing.md)。
