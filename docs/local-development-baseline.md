# 本地开发与正式服务基准

2026-10-28 整理时，用户指定以本机 3000 端口正式服务为准。

## 已核对的正式版本

- 发布版本：`20261028045314-6d2f822-dirty-40f734f2`。
- 发布时间：2026-10-28 12:53（Asia/Shanghai）。
- 发布目录：`.remote-server/current` 指向上述版本。
- 源码快照：`.code/monitor-only-release/source`。
- 核验依据：发布目录的 `SOURCE_MANIFEST.json`；其记录的七个文件 SHA-256 与快照一致。

本次将快照内的 `src`、`public`、`scripts`、`tests` 和根目录构建配置完整对齐到工作区。文档、Git 忽略规则及快照未包含的辅助文档配置来自 GitHub 已有的 `82111b0`，并补充本记录。它们不是正式运行程序的差异。

本地 `main` 从 GitHub 已有的 `82111b0` 继续记录本次对齐提交；此前的本地提交保存在 `codex/archive-before-production-align-20261028`，仅供恢复，不作为开发基准。

## 整理后的边界

- 正式服务不发布、不重启，仍运行原发布目录。
- GitHub 不推送、不强制改写历史。
- 侧栏滚动修复单独保留在工作区：`src/app/styles/01-base.css` 中 `overflow-x: hidden` 改为 `clip`。
- 业务资料库、环境配置、输出、交付文件均留在本地，不进入提交。
- 本次恢复备份放在 `.code/git-organize-20261028`；先前撤销代码的备份放在 `.code/before-discard-unpublished-20261028-175727`。

## 后续操作

1. 日常修改在当前工作区进行，以 `git status --short` 确认范围。
2. Git 提交只保存代码版本；推送只同步 GitHub，不等于上线。
3. 发布正式服务需单独授权，并走现有发布脚本；不直接修改 `.remote-server/current` 内的文件。
4. 开发与正式服务使用不同端口，构建不得干扰运行中的开发产物；业务测试使用隔离资料库。
5. 旧分支和 `.code` 快照仅用于恢复，不再混入日常提交。
