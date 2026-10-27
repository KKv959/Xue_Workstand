import fs from "fs";
import path from "path";
import process from "process";

const platforms = ["bilibili", "douyin"];
const grossMarginPlatforms = ["bilibili", "douyin"];
const grossMarginServices = ["play", "like", "douPlus", "coin", "comment", "share", "favorite", "danmaku", "blueLink"];
const root = path.resolve(process.cwd(), process.env.STYLE_LIBRARY_DIR || "style-library");
const repairMode = process.argv.includes("--repair");
const issues = [];
const repairs = [];
const repairStamp = new Date().toISOString().replace(/[:.]/g, "-");
const repairRoot = path.join(root, ".repairs", repairStamp);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    issues.push({
      type: error && typeof error === "object" && error.code === "ENOENT" ? "missing-json" : "invalid-json",
      file,
      detail: error instanceof Error ? error.message : "JSON 读取失败"
    });
    return null;
  }
}

function exists(file) {
  return fs.existsSync(file);
}

function resolveStoredPath(storedPath) {
  if (path.isAbsolute(storedPath)) return path.normalize(storedPath);
  const target = path.resolve(root, storedPath.split("/").join(path.sep));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function libraryRelativePath(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function dirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    pushIssue("directory-read-failed", dir, error instanceof Error ? error.message : "目录读取失败");
    return [];
  }
}

function files(dir, extension) {
  try {
    return fs.readdirSync(dir).filter((file) => file.endsWith(extension));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    pushIssue("directory-read-failed", dir, error instanceof Error ? error.message : "目录读取失败");
    return [];
  }
}

function isCopySourceJson(file) {
  return file.endsWith(".json") && !file.endsWith(".style-analysis.json");
}

function pushIssue(type, file, detail) {
  issues.push({ type, file, detail });
}

function writeRepair(file, value, reason) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒绝修复素材库之外的文件：${file}`);
  }

  const backup = path.join(repairRoot, relative);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);

  const temporary = `${file}.${process.pid}.${Date.now()}.repair.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // 临时文件清理失败不会覆盖原始修复错误；备份仍保留在 repairRoot。
    }
  }
  repairs.push({ file, backup, reason });
}

const accountIds = new Set();
const accountVideoIds = new Map();
const copySourceIds = new Set();
const copySourceProjectRefs = new Map();
const projectIds = new Set();
const projectSourceRefs = new Map();
const draftsWithStyleRefs = [];

for (const platform of platforms) {
  for (const slug of dirs(path.join(root, platform))) {
    const base = path.join(root, platform, slug);
    const accountFile = path.join(base, "account.json");
    if (!exists(accountFile)) {
      pushIssue("missing-account-json", accountFile, "account directory exists but account.json is missing");
      continue;
    }
    const account = readJson(accountFile);
    if (!account) continue;

    const expectedAccountId = `${platform}:${slug}`;
    accountIds.add(expectedAccountId);
    if (account.id !== expectedAccountId) {
      pushIssue("account-id-slug-mismatch", accountFile, `id=${account.id}, expected=${expectedAccountId}`);
    }

    const videoDir = path.join(base, "videos");
    const transcriptDir = path.join(base, "transcripts");
    const draftDir = path.join(base, "drafts");
    const videoIds = new Set(files(videoDir, ".json").map((file) => file.slice(0, -5)));
    accountVideoIds.set(expectedAccountId, videoIds);

    for (const file of files(videoDir, ".json")) {
      const id = file.slice(0, -5);
      const videoFile = path.join(videoDir, file);
      let video = readJson(videoFile);
      if (!video) continue;

      const transcriptFile = path.join(transcriptDir, `${id}.txt`);
      const hasTranscript = exists(transcriptFile);
      if (repairMode) {
        const nextVideo = repairedTranscriptMetadata(video, transcriptFile, hasTranscript);
        if (nextVideo) {
          writeRepair(videoFile, nextVideo, hasTranscript ? "同步已有转写文件的元数据" : "清理缺失转写文件的失效元数据");
          video = nextVideo;
        }
      }

      if (video.id !== id) {
        pushIssue("video-id-filename-mismatch", videoFile, `id=${video.id}, file=${id}`);
      }
      if (video.accountId !== account.id) {
        pushIssue("video-account-mismatch", videoFile, `video.accountId=${video.accountId}, account=${account.id}`);
      }
      if (hasTranscript && video.transcriptStatus !== "completed") {
        pushIssue("transcript-file-status-mismatch", videoFile, `has transcript but status=${video.transcriptStatus}`);
      }
      if (!hasTranscript && video.transcriptStatus === "completed") {
        pushIssue("missing-transcript-file", videoFile, "status completed but txt missing");
      }
      if (video.transcriptPath && !exists(resolveStoredPath(video.transcriptPath) || "")) {
        pushIssue("stale-transcript-path", videoFile, video.transcriptPath);
      }
    }

    for (const file of files(transcriptDir, ".txt")) {
      const id = file.slice(0, -4);
      if (!videoIds.has(id)) {
        pushIssue("orphan-transcript", path.join(transcriptDir, file), "txt without video json");
      }
    }

    for (const file of files(draftDir, ".json")) {
      const draftFile = path.join(draftDir, file);
      const draft = readJson(draftFile);
      if (!draft) continue;
      const expectedDraftId = file.slice(0, -5);

      if (draft.id !== expectedDraftId) {
        pushIssue("draft-id-filename-mismatch", draftFile, `id=${draft.id}, file=${expectedDraftId}`);
      }
      if (draft.targetType !== "project" && draft.accountId !== expectedAccountId) {
        pushIssue("draft-account-mismatch", draftFile, `draft.accountId=${draft.accountId}, account=${expectedAccountId}`);
      }

      if (draft.targetType === "project") {
        pushIssue("project-draft-in-account-dir", draftFile, draft.projectId);
      }
      if (draft.styleRef?.videoIds) {
        const missing = draft.styleRef.videoIds.filter((id) => !videoIds.has(id));
        if (missing.length) {
          pushIssue("draft-missing-video-ref", draftFile, missing.join(","));
        }
      }
      if (Array.isArray(draft.styleRefs)) draftsWithStyleRefs.push({ draft, draftFile });
    }
  }
}

checkDouyinHotlistWatchlist();

for (const file of files(path.join(root, "copy-tools", "sources"), ".json").filter(isCopySourceJson)) {
  const sourceFile = path.join(root, "copy-tools", "sources", file);
  const source = readJson(sourceFile);
  if (!source) continue;

  const expectedSourceId = file.slice(0, -5);
  copySourceIds.add(expectedSourceId);
  copySourceProjectRefs.set(expectedSourceId, {
    file: sourceFile,
    projectIds: new Set(Array.isArray(source.projectIds) ? source.projectIds.filter(Boolean) : [])
  });
  if (source.id !== expectedSourceId) {
    pushIssue("copy-source-id-filename-mismatch", sourceFile, `id=${source.id}, file=${expectedSourceId}`);
  }

  const transcriptFile = path.join(root, "copy-tools", "sources", `${expectedSourceId}.txt`);
  if (!exists(transcriptFile)) {
    pushIssue("copy-source-missing-transcript", sourceFile, "json without txt");
  }
}

for (const file of files(path.join(root, "copy-tools", "sources"), ".txt")) {
  const expectedJsonFile = path.join(root, "copy-tools", "sources", `${file.slice(0, -4)}.json`);
  if (!exists(expectedJsonFile)) {
    pushIssue("orphan-copy-source-transcript", path.join(root, "copy-tools", "sources", file), "txt without json");
  }
}

for (const slug of dirs(path.join(root, "projects"))) {
  const base = path.join(root, "projects", slug);
  const projectFile = path.join(base, "project.json");
  if (!exists(projectFile)) {
    pushIssue("missing-project-json", projectFile, "project directory exists but project.json is missing");
    continue;
  }
  const project = readJson(projectFile);
  if (!project) continue;

  const expectedProjectId = `project:${slug}`;
  projectIds.add(expectedProjectId);
  if (project.id !== expectedProjectId) {
    pushIssue("project-id-slug-mismatch", projectFile, `id=${project.id}, expected=${expectedProjectId}`);
  }

  projectSourceRefs.set(expectedProjectId, new Set(project.sourceMaterialIds || []));

  const missingAccounts = (project.sourceAccountIds || []).filter((id) => !accountIds.has(id));
  if (missingAccounts.length) {
    pushIssue("project-missing-account-ref", projectFile, missingAccounts.join(","));
  }

  const missingCopySources = (project.sourceMaterialIds || []).filter((id) => !copySourceIds.has(id));
  if (missingCopySources.length) {
    pushIssue("project-missing-copy-source-ref", projectFile, missingCopySources.join(","));
  }

  for (const file of files(path.join(base, "drafts"), ".json")) {
    const draftFile = path.join(base, "drafts", file);
    const draft = readJson(draftFile);
    if (!draft) continue;
    const expectedDraftId = file.slice(0, -5);

    if (draft.id !== expectedDraftId) {
      pushIssue("draft-id-filename-mismatch", draftFile, `id=${draft.id}, file=${expectedDraftId}`);
    }
    if (draft.targetType === "project" && draft.projectId !== expectedProjectId) {
      pushIssue("draft-project-mismatch", draftFile, `draft.projectId=${draft.projectId}, project=${expectedProjectId}`);
    }

    if (draft.targetType !== "project") {
      pushIssue("account-draft-in-project-dir", draftFile, draft.accountId);
    }
    if (draft.styleRef?.sourceAccountIds) {
      const missing = draft.styleRef.sourceAccountIds.filter((id) => !accountIds.has(id));
      if (missing.length) {
        pushIssue("project-draft-missing-account-ref", draftFile, missing.join(","));
      }
    }
    if (draft.styleRef?.sourceMaterialIds) {
      const missing = draft.styleRef.sourceMaterialIds.filter((id) => !copySourceIds.has(id));
      if (missing.length) {
        pushIssue("project-draft-missing-copy-source-ref", draftFile, missing.join(","));
      }
    }
    if (Array.isArray(draft.styleRefs)) draftsWithStyleRefs.push({ draft, draftFile });
  }
}

for (const { draft, draftFile } of draftsWithStyleRefs) {
  const seen = new Set();
  for (const reference of draft.styleRefs) {
    const key = reference.targetType === "project"
      ? `project:${reference.projectId}`
      : `account:${reference.platform}:${reference.accountId}`;
    if (seen.has(key)) pushIssue("draft-duplicate-style-ref", draftFile, key);
    seen.add(key);

    if (reference.targetType === "project") {
      if (!projectIds.has(reference.projectId)) {
        pushIssue("draft-missing-project-style-ref", draftFile, reference.projectId);
      }
      const missingAccounts = (reference.sourceAccountIds || []).filter((id) => !accountIds.has(id));
      if (missingAccounts.length) pushIssue("draft-style-ref-missing-account", draftFile, missingAccounts.join(","));
      const missingSources = (reference.sourceMaterialIds || []).filter((id) => !copySourceIds.has(id));
      if (missingSources.length) pushIssue("draft-style-ref-missing-copy-source", draftFile, missingSources.join(","));
      continue;
    }

    if (!accountIds.has(reference.accountId)) {
      pushIssue("draft-missing-account-style-ref", draftFile, reference.accountId);
      continue;
    }
    const missingVideos = (reference.videoIds || []).filter((id) => !accountVideoIds.get(reference.accountId)?.has(id));
    if (missingVideos.length) pushIssue("draft-style-ref-missing-video", draftFile, missingVideos.join(","));
  }
}

for (const [sourceId, sourceRef] of copySourceProjectRefs.entries()) {
  for (const projectId of sourceRef.projectIds) {
    if (!projectIds.has(projectId)) {
      pushIssue("copy-source-missing-project-ref", sourceRef.file, `${sourceId} -> ${projectId}`);
      continue;
    }
    if (!projectSourceRefs.get(projectId)?.has(sourceId)) {
      pushIssue("copy-source-stale-project-backref", sourceRef.file, `${sourceId} -> ${projectId}`);
    }
  }
}

for (const [projectId, sourceIds] of projectSourceRefs.entries()) {
  for (const sourceId of sourceIds) {
    const sourceRef = copySourceProjectRefs.get(sourceId);
    if (sourceRef && !sourceRef.projectIds.has(projectId)) {
      pushIssue("copy-source-missing-project-backref", sourceRef.file, `${sourceId} missing ${projectId}`);
    }
  }
}

checkGrossMarginLibrary();

function checkDouyinHotlistWatchlist() {
  const hotlistAccountIds = new Set();
  for (const slug of dirs(path.join(root, "douyin-hotlist", "accounts"))) {
    const base = path.join(root, "douyin-hotlist", "accounts", slug);
    const accountFile = path.join(base, "account.json");
    const account = readJson(accountFile);
    if (!account) continue;

    const expectedAccountId = `douyin-hotlist:${slug}`;
    hotlistAccountIds.add(expectedAccountId);
    if (account.id !== expectedAccountId) {
      pushIssue("douyin-hotlist-account-id-slug-mismatch", accountFile, `id=${account.id}, expected=${expectedAccountId}`);
    }
    if (account.platform !== "douyin" && account.platform !== "bilibili") {
      pushIssue("douyin-hotlist-account-invalid-platform", accountFile, String(account.platform));
    }

    for (const file of files(path.join(base, "videos"), ".json")) {
      const id = file.slice(0, -5);
      const videoFile = path.join(base, "videos", file);
      const video = readJson(videoFile);
      if (!video) continue;
      if (video.id !== id) {
        pushIssue("douyin-hotlist-video-id-filename-mismatch", videoFile, `id=${video.id}, file=${id}`);
      }
      if (video.accountId !== account.id) {
        pushIssue("douyin-hotlist-video-account-mismatch", videoFile, `video.accountId=${video.accountId}, account=${account.id}`);
      }
      if (video.platform !== account.platform) {
        pushIssue("douyin-hotlist-video-platform-mismatch", videoFile, `video.platform=${video.platform}, account=${account.platform}`);
      }
    }
  }

  const watchlistFile = path.join(root, "douyin-hotlist", "watchlist.json");
  if (!exists(watchlistFile)) return;

  const watchlist = readJson(watchlistFile);
  if (!watchlist) return;
  if (!Array.isArray(watchlist.accountIds)) {
    pushIssue("douyin-hotlist-invalid-account-ids", watchlistFile, "accountIds must be an array");
    return;
  }

  const seen = new Set();
  for (const accountId of watchlist.accountIds) {
    if (typeof accountId !== "string" || !accountId.trim()) {
      pushIssue("douyin-hotlist-invalid-account-ref", watchlistFile, JSON.stringify(accountId));
      continue;
    }
    if (seen.has(accountId)) {
      pushIssue("douyin-hotlist-duplicate-account-ref", watchlistFile, accountId);
    }
    seen.add(accountId);
    if (!accountId.startsWith("douyin-hotlist:")) {
      pushIssue("douyin-hotlist-invalid-account-ref-scope", watchlistFile, accountId);
      continue;
    }
    if (!hotlistAccountIds.has(accountId)) {
      pushIssue("douyin-hotlist-missing-account-ref", watchlistFile, accountId);
    }
  }
}

function checkGrossMarginLibrary() {
  const grossMarginRoot = path.join(root, "gross-margin");
  if (!exists(grossMarginRoot)) return;

  const monitorKeys = new Map();
  for (const platform of grossMarginPlatforms) {
    checkGrossMarginPriceTable(platform, path.join(grossMarginRoot, `${platform}.json`));
  }
  checkGrossMarginAccounts(path.join(grossMarginRoot, "accounts.json"));

  for (const file of files(path.join(grossMarginRoot, "categories"), ".json")) {
    const categoryFile = path.join(grossMarginRoot, "categories", file);
    const category = readJson(categoryFile);
    if (!category) continue;
    const expectedCategoryId = file.slice(0, -5);
    if (category.id !== expectedCategoryId) {
      pushIssue("gross-margin-category-id-filename-mismatch", categoryFile, `id=${category.id}, file=${expectedCategoryId}`);
    }
    if (!category.name?.trim()) {
      pushIssue("gross-margin-category-missing-name", categoryFile, "name is empty");
    }
    if (!Array.isArray(category.tiers)) {
      pushIssue("gross-margin-category-invalid-tiers", categoryFile, "tiers must be an array");
    }
  }

  for (const file of files(path.join(grossMarginRoot, "monitor-records"), ".json")) {
    const recordFile = path.join(grossMarginRoot, "monitor-records", file);
    const record = readJson(recordFile);
    if (!record) continue;
    const expectedRecordId = file.slice(0, -5);
    if (record.id !== expectedRecordId) {
      pushIssue("gross-margin-monitor-id-filename-mismatch", recordFile, `id=${record.id}, file=${expectedRecordId}`);
    }
    if (!grossMarginPlatforms.includes(record.platform)) {
      pushIssue("gross-margin-monitor-invalid-platform", recordFile, String(record.platform));
    }
    if (!record.videoKey?.trim()) {
      pushIssue("gross-margin-monitor-missing-video-key", recordFile, "videoKey is empty");
    }
    if (!record.videoUrl?.trim()) {
      pushIssue("gross-margin-monitor-missing-video-url", recordFile, "videoUrl is empty");
    }
    if (!record.targetStats || typeof record.targetStats !== "object" || Array.isArray(record.targetStats)) {
      pushIssue("gross-margin-monitor-invalid-target-stats", recordFile, "targetStats must be an object");
    }
    const duplicateKey = `${record.platform}:${record.videoKey || ""}:${record.projectId || ""}`;
    const existingFile = monitorKeys.get(duplicateKey);
    if (existingFile) {
      pushIssue("gross-margin-monitor-duplicate-video-key", recordFile, `duplicates ${existingFile}`);
    } else {
      monitorKeys.set(duplicateKey, recordFile);
    }
  }
}

function checkGrossMarginPriceTable(platform, file) {
  if (!exists(file)) return;
  const table = readJson(file);
  if (!table) return;
  if (table.platform !== platform) {
    pushIssue("gross-margin-price-table-platform-mismatch", file, `platform=${table.platform}, expected=${platform}`);
  }
  if (!Array.isArray(table.items)) {
    pushIssue("gross-margin-price-table-invalid-items", file, "items must be an array");
    return;
  }
  const itemIds = new Set();
  for (const item of table.items) {
    if (!item?.id?.trim()) {
      pushIssue("gross-margin-price-item-missing-id", file, JSON.stringify(item));
      continue;
    }
    if (itemIds.has(item.id)) {
      pushIssue("gross-margin-price-item-duplicate-id", file, item.id);
    }
    itemIds.add(item.id);
    if (!grossMarginServices.includes(item.service)) {
      pushIssue("gross-margin-price-item-invalid-service", file, `${item.id}: ${item.service}`);
    }
    if (typeof item.unitPrice !== "number" || !Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      pushIssue("gross-margin-price-item-invalid-unit-price", file, `${item.id}: ${item.unitPrice}`);
    }
  }
}

function checkGrossMarginAccounts(file) {
  if (!exists(file)) return;
  const accounts = readJson(file);
  if (!accounts) return;
  if (!Array.isArray(accounts)) {
    pushIssue("gross-margin-accounts-invalid", file, "accounts must be an array");
    return;
  }
  const accountKeys = new Set();
  for (const account of accounts) {
    if (!grossMarginPlatforms.includes(account?.platform)) {
      pushIssue("gross-margin-account-invalid-platform", file, JSON.stringify(account));
      continue;
    }
    if (!account.name?.trim()) {
      pushIssue("gross-margin-account-missing-name", file, JSON.stringify(account));
    }
    const key = `${account.platform}:${account.name || ""}`;
    if (accountKeys.has(key)) {
      pushIssue("gross-margin-account-duplicate", file, key);
    }
    accountKeys.add(key);
    if (typeof account.defaultPrice !== "number" || !Number.isFinite(account.defaultPrice) || account.defaultPrice < 0) {
      pushIssue("gross-margin-account-invalid-default-price", file, `${key}: ${account.defaultPrice}`);
    }
  }
}

function repairedTranscriptMetadata(video, transcriptFile, hasTranscript) {
  if (hasTranscript) {
    const transcriptPath = libraryRelativePath(transcriptFile);
    if (video.transcriptStatus === "completed" && video.transcriptPath === transcriptPath) return null;
    return {
      ...video,
      transcriptStatus: "completed",
      transcriptPath,
      updatedAt: new Date().toISOString()
    };
  }

  if (
    video.transcriptStatus !== "completed" &&
    !video.transcriptPath &&
    !video.transcriptRevision &&
    !video.transcriptSource
  ) {
    return null;
  }

  const next = {
    ...video,
    transcriptStatus: video.transcriptStatus === "failed" ? "failed" : "not_started",
    updatedAt: new Date().toISOString()
  };
  delete next.transcriptPath;
  delete next.transcriptRevision;
  delete next.transcriptSource;
  return next;
}

const counts = issues.reduce((acc, issue) => {
  acc[issue.type] = (acc[issue.type] || 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      root,
      repairMode,
      repairCount: repairs.length,
      repairs,
      issueCount: issues.length,
      counts,
      issues
    },
    null,
    2
  )
);

if (issues.length) {
  process.exitCode = 1;
}
