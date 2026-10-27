import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { legacyProject } from "./helpers/legacy-project";
import { prepareWriteCopyContext } from "../src/lib/ai";
import { getJob, listJobs } from "../src/lib/jobs";
import { startJobSchema } from "../src/lib/job-validation";
import { writeCopyInputSchema } from "../src/lib/write-validation";
import { readAiSettings, saveAiSettings } from "../src/lib/storage/ai-settings";
import { getAiSettingsView } from "../src/lib/ai-policy-runtime";
import { ensureLibrary, ensureDraftAssetDir, getDraftAssetFile, getDraftSummaries, resolveDraft, resolveProject, saveDraft, updateDraftAssets } from "../src/lib/storage";
import { writeFileAtomic, writeJsonFile } from "../src/lib/storage/fs";
import { POST as writeRoute } from "../src/app/api/write/route";
import { POST as jobsRoute } from "../src/app/api/jobs/route";
import { POST as saveRoute } from "../src/app/api/drafts/route";

test("移除功能拒绝新请求，旧项目、稿件、封面和模型设置仍兼容", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "removed-modules-"));
  const env = { ...process.env };
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, APP_MODE: "workspace" });
  try {
    await ensureLibrary();
    for (const dir of ["projects", "copy-tools"]) await assert.rejects(access(path.join(root, dir)), { code: "ENOENT" });
    const project = await legacyProject({ name: "历史项目" });
    const originalProject = await readFile(path.join(root, "projects", project.slug, "project.json"), "utf8");
    const draft = await saveDraft({ targetType: "project", projectId: project.id, projectName: project.name,
      title: "历史项目稿", mode: "topic", prompt: "历史要求", content: "原始正文",
      styleRef: { projectId: project.id, projectName: project.name, sourceAccountIds: [] } });
    const assets = await ensureDraftAssetDir(draft.id, "covers");
    const bytes = Buffer.from("历史封面字节");
    await writeFileAtomic(path.join(assets.dir, "old.png"), bytes);
    const cover = { references: [], images: [{ id: "old", path: "covers/old.png", prompt: "历史封面", model: "old", size: "1024x1024", quality: "low", referenceIds: [], format: "png" as const, createdAt: draft.createdAt }], updatedAt: draft.createdAt };
    await updateDraftAssets(draft.id, { cover });
    const archived = (await resolveDraft(draft.id)).draft;
    assert.ok((await getDraftSummaries()).some(item => item.id === draft.id));
    assert.deepEqual((await getDraftAssetFile(draft.id, "covers/old.png")).bytes, bytes);
    await assert.rejects(getDraftAssetFile(draft.id, "../escape"), /不在当前草稿目录/);

    for (const input of [{ targetType: "project", projectId: project.id },
      { styleRefs: [{ targetType: "project", projectId: project.id }] }, { projectId: project.id }]) {
      const body = { ...input, mode: "topic", prompt: "新稿" };
      assert.equal(writeCopyInputSchema.safeParse(body).success, false);
      const response = await writeRoute(new Request("http://localhost/api/write", { method: "POST", body: JSON.stringify(body) }));
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /项目写作已移除/);
    }
    for (const kind of ["project-style", "image-cover"]) {
      assert.equal(startJobSchema.safeParse({ kind, input: { draftId: draft.id } }).success, false);
      const response = await jobsRoute(new Request("http://localhost/api/jobs", { method: "POST", body: JSON.stringify({ kind, input: {} }) }));
      assert.equal(response.status, 400);
    }
    await assert.rejects(prepareWriteCopyContext({ action: "revise", mode: "topic", prompt: "",
      parentDraftId: draft.id, currentContent: draft.content, revisionInstruction: "精简" }), /项目写作已移除/);
    const saved = await saveRoute(new Request("http://localhost/api/drafts", { method: "POST", body: JSON.stringify({
      ...archived, assets: undefined, content: "手动修改", version: { sessionId: draft.id, parentDraftId: draft.id, revision: 2,
        origin: "manual_edit", promptVersion: "legacy", contextFingerprint: "legacy" }
    }) }));
    assert.equal(saved.status, 200);
    assert.equal((await resolveDraft(draft.id)).draft.content, "原始正文");
    assert.deepEqual((await resolveDraft(draft.id)).draft.assets?.cover, cover);
    assert.equal((await resolveProject(project.id)).id, project.id);
    assert.equal(await readFile(path.join(root, "projects", project.slug, "project.json"), "utf8"), originalProject);

    const settings = { schemaVersion: 1, revision: 7, updatedAt: null, overrides: {
      project_sample: { model: "old", effort: "medium" }, project_style: { model: "old", effort: "high" }, image_cover: { model: "old-image", effort: "none" }
    } };
    const settingsFile = path.join(root, "settings", "ai-models.json");
    await writeJsonFile(settingsFile, settings);
    const settingsRaw = await readFile(settingsFile, "utf8");
    assert.deepEqual(await readAiSettings(), settings);
    const view = await getAiSettingsView();
    for (const id of Object.keys(settings.overrides)) assert.equal(id in view.effective, false);
    assert.equal(await readFile(settingsFile, "utf8"), settingsRaw);
    const activeOverride = { model: "current", effort: "medium" as const };
    const currentSettings = await readAiSettings();
    const updatedSettings = await saveAiSettings({ ...currentSettings, overrides: {
      ...currentSettings.overrides, writer_generate: activeOverride
    } });
    assert.deepEqual(updatedSettings.overrides, { writer_generate: activeOverride });
    assert.equal(updatedSettings.revision, settings.revision + 1);
    assert.deepEqual((await readAiSettings()).overrides, updatedSettings.overrides);

    for (const kind of ["project-style", "image-cover"] as const) {
      await writeJsonFile(path.join(root, "jobs", `${kind}.json`), { schemaVersion: 1, id: kind, kind,
        status: "queued", title: "旧任务", message: "排队中", progress: 0, createdAt: draft.createdAt, updatedAt: draft.createdAt });
    }
    await listJobs();
    for (const kind of ["project-style", "image-cover"] as const) {
      const job = await getJob(kind);
      assert.equal(job.status, "interrupted");
      assert.match(job.message, /功能已移除/);
      assert.equal(job.recoveryError, undefined);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
