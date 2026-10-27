"use client";
import { imageModelBatch } from "@/lib/image-model-batch";
import { imageModelLabel } from "@/lib/image-profile-options";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTasks } from "@/components/TaskProvider";
import { confirmDiscardUnsavedChanges } from "@/components/UnsavedChangesGuard";
import { deleteImageGenerationRecords, restoreLibraryTrashOperation, getImageGenerationConfig, getImageGenerationRecord, getCachedImageRecords, getImageRecords, invalidateImageRecordsCache, uploadImageReferences } from "@/lib/client";
import { imageGenerationInputSchema, type ImageFile, type ImageGenerationConfig, type ImageGenerationInput, type ImageGenerationRecord, type ImageGenerationSummary } from "@/lib/image-generation-types";
import { imageMentionToken, imageMentionPattern, resolveImageMentions, appendImageMention, removeImageMention } from "@/lib/image-mentions";

function emptyForm(profileId?: string): ImageGenerationInput {
  return { profileId: profileId && profileId !== "default" ? profileId : undefined, prompt: "", size: "auto", quality: "auto", count: 1, referenceIds: [] };
}
export function useImageWorkbench() {
  const router = useRouter();
  const search = useSearchParams();
  const id = search.get("recordId") || "";
  const { jobs, startTask, cancelTask } = useTasks();
  const [config, setConfig] = useState<ImageGenerationConfig | null>(null);
  const [form, setForm] = useState<ImageGenerationInput>(() => emptyForm());
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyForm()));
  const [references, setReferences] = useState<ImageFile[]>([]);
  const [recordReferences, setRecordReferences] = useState<ImageFile[]>([]);
  const [records, setRecords] = useState<ImageGenerationSummary[]>(() => getCachedImageRecords()?.records || []);
  const [boardRecords, setBoardRecords] = useState<ImageGenerationSummary[]>([]);
  const [total, setTotal] = useState(() => getCachedImageRecords()?.total || 0);
  const [boardTotal, setBoardTotal] = useState(0);
  const [canvasId, setCanvasId] = useState("");
  const [record, setRecord] = useState<ImageGenerationRecord | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deletion, setDeletion] = useState<{ message: string; operationId?: string } | null>(null);
  const deleteLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(() => !getCachedImageRecords());
  const [boardLoading, setBoardLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [activeId, setActiveId] = useState(id);
  const [multiModels, setMultiModels] = useState<string[]>([]);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const uploadLock = useRef(false);
  const submitLock = useRef(false);
  const moreLock = useRef(false);
  const formTouched = useRef(false);
  const didHydrate = useRef(false);
  const defaultProfileId = useRef("default");
  const listRevision = useRef(0);
  const boardRevision = useRef(0);
  const listLimit = useRef(40);
  const boardLimit = useRef({ canvasId: "", count: 40 });
  const job = jobs.find((entry) => entry.id === activeId);
  const selectedJob = jobs.find((entry) => entry.id === id);
  const batchJobs = jobs.filter((entry) => batchIds.includes(entry.id) || (boardRecords.some((record) => record.id === entry.id) && (entry.status === "running" || entry.status === "queued")));
  const active = [job, ...batchJobs].some((entry) => entry?.status === "running" || entry?.status === "queued");
  const imageJobs = jobs.filter((entry) => entry.kind === "image-generation");
  const taskVersion = imageJobs.filter((entry) => entry.dataRevision).map((entry) => `${entry.id}:${entry.dataRevision}`).sort().join("|");
  const boardTaskVersion = imageJobs.filter((entry) => entry.dataRevision && (entry.scope?.canvasId === canvasId || entry.id === id || boardRecords.some((record) => record.id === entry.id))).map((entry) => `${entry.id}:${entry.dataRevision}`).sort().join("|");
  const dirty = JSON.stringify(form) !== baseline;
  const fail = useCallback((error: unknown) => setError(error instanceof Error ? error.message : "操作失败，请重试。"), []);

  useEffect(() => {
    let alive = true;
    getImageGenerationConfig().then((value) => {
      if (!alive) return;
      setConfig(value); defaultProfileId.current = value.defaultProfileId;
      if (!didHydrate.current && !formTouched.current) {
        const next = emptyForm(value.defaultProfileId); setForm(next); setBaseline(JSON.stringify(next));
      }
    }).catch((error) => { if (alive) fail(error); });
    return () => { alive = false; };
  }, [fail]);

  const refresh = useCallback(async (options: { fresh?: boolean } = {}) => {
    const revision = ++listRevision.current;
    if (options.fresh !== false) invalidateImageRecordsCache();
    try {
      const data = await getImageRecords(0, undefined, listLimit.current);
      if (revision !== listRevision.current) return;
      setRecords(data.records); setTotal(data.total);
    } catch (error) { if (revision === listRevision.current) fail(error); }
    finally { if (revision === listRevision.current) setLoading(false); }
  }, [fail]);
  // TaskProvider invalidates changed image data; entering this page can reuse the existing list.
  useEffect(() => { void refresh({ fresh: false }); }, [taskVersion, refresh]);
  const refreshBoard = useCallback(async () => {
    const revision = ++boardRevision.current;
    if (!canvasId) { setBoardRecords([]); setBoardTotal(0); setBoardLoading(false); return; }
    if (boardLimit.current.canvasId !== canvasId) boardLimit.current = { canvasId, count: 40 };
    setBoardLoading(true);
    try {
      const data = await getImageRecords(0, canvasId, boardLimit.current.count);
      if (revision !== boardRevision.current) return;
      setBoardRecords(data.records); setBoardTotal(data.total);
    } catch (error) { if (revision === boardRevision.current) fail(error); }
    finally { if (revision === boardRevision.current) setBoardLoading(false); }
  }, [canvasId, fail]);
  useEffect(() => { void refreshBoard(); }, [boardTaskVersion, refreshBoard]);

  useEffect(() => {
    let alive = true;
    if (!id) { setRecord(null); setRecordReferences([]); setDetailLoading(false); return; }
    if ((selectedJob?.status === "running" || selectedJob?.status === "queued") && !selectedJob.dataRevision) { setDetailLoading(false); return; }
    setDetailLoading(true);
    getImageGenerationRecord(id).then(({ record: next, references: refs }) => {
      if (!alive) return;
      setRecord(next); setRecordReferences(refs); setCanvasId(next.canvasId || next.id);
      if (!didHydrate.current && !formTouched.current) {
        const nextForm = { profileId: next.profileId, prompt: refs.reduce((prompt, ref) => appendImageMention(prompt, ref.id, ref.name), next.prompt), size: next.size, quality: next.quality, count: 1, referenceIds: next.referenceIds };
        setForm(nextForm); setBaseline(JSON.stringify(nextForm)); setReferences(refs);
      }
      didHydrate.current = true;
    }).catch((error) => { if (alive) fail(error); }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [id, selectedJob?.dataRevision, selectedJob?.status, fail]);

  function select(nextId: string) {
    if (uploadLock.current || submitLock.current || nextId === id) return;
    didHydrate.current = true;
    setError(""); setRecord(null); setRecordReferences([]);
    router.replace(`/images?recordId=${encodeURIComponent(nextId)}`, { scroll: false });
  }
  function newRecord() {
    if (uploadLock.current || submitLock.current || !confirmDiscardUnsavedChanges("新建画布会清空当前未生成的输入，是否继续？")) return false;
    const next = emptyForm(defaultProfileId.current);
    setBatchIds([]); setActiveId(""); setForm(next); setBaseline(JSON.stringify(next)); setReferences([]); setError("");
    setRecord(null); setRecordReferences([]); setCanvasId(crypto.randomUUID()); setBoardRecords([]); setBoardTotal(0);
    formTouched.current = false; didHydrate.current = true;
    router.replace("/images", { scroll: false });
    return true;
  }
  async function reproduce(recordId: string) {
    if (submitLock.current || uploadLock.current || !confirmDiscardUnsavedChanges("复现会替换当前未生成的输入，是否继续？")) return;
    submitLock.current = true; setBusy(true); setError("");
    try {
      const { record: source, references: refs } = await getImageGenerationRecord(recordId);
      const next: ImageGenerationInput = { profileId: source.profileId, prompt: source.prompt, size: source.size, quality: source.quality, count: source.count, referenceIds: source.referenceIds, canvasId, parentRecordId: source.id };
      setForm(next); setReferences(refs); setMultiModels([]); formTouched.current = true;
    } catch (error) { fail(error); }
    finally { submitLock.current = false; setBusy(false); }
  }
  function addResultReferences(images: ImageFile[]) {
    if (submitLock.current || uploadLock.current) return;
    const additions = images.filter((image) => !form.referenceIds.includes(image.id));
    if (form.referenceIds.length + additions.length > 6) { setError("加入本组图片后将超过 6 张参考图，请先移除多余参考图，或单独拖入需要的图片。"); return; }
    setReferences((current) => [...current, ...additions]);
    setForm((current) => ({ ...current, referenceIds: [...current.referenceIds, ...additions.map((image) => image.id)], prompt: additions.reduce((prompt, image) => appendImageMention(prompt, image.id, image.name), current.prompt) }));
    formTouched.current = true;
  }
  async function generate(input: ImageGenerationInput = form) {
    if (submitLock.current || uploadLock.current || detailLoading) return false;
    submitLock.current = true; setBusy(true); setError("");
    try {
      const targetCanvas = canvasId || crypto.randomUUID();
      const parentMatches = input.canvasId === targetCanvas;
      const payload = { ...input, canvasId: targetCanvas, parentRecordId: parentMatches ? input.parentRecordId : undefined, parentImageId: parentMatches ? input.parentImageId : undefined };
      const inputs = imageModelBatch(payload, input === form ? multiModels : [], config?.profiles || []).map((item) => imageGenerationInputSchema.parse(item));
      inputs.forEach((item) => resolveImageMentions(item.prompt, item.referenceIds));
      const started: string[] = [];
      const failures: string[] = [];
      for (const item of inputs) {
        try {
          const modelLabel = imageModelLabel(config?.profiles.find((profile) => profile.id === item.profileId)?.model || "图片");
          const next = await startTask({ kind: "image-generation", title: `${modelLabel} · ${item.count} 张`, input: item });
          started.push(next.id); setBatchIds((current) => [...current, next.id]);
        } catch (reason) {
          const model = config?.profiles.find((profile) => profile.id === item.profileId)?.model || "模型";
          failures.push(`${imageModelLabel(model)}：${reason instanceof Error ? reason.message : "提交失败"}`);
        }
      }
      if (!started.length) throw new Error(failures.join("；"));
      if (failures.length) setError(`已启动 ${started.length} 个模型任务；${failures.join("；")}。已启动的任务会继续执行。`);
      didHydrate.current = true; formTouched.current = true; setActiveId(started[0]); setCanvasId(targetCanvas);
      setBaseline(JSON.stringify(input)); setRecord(null);
      router.replace(`/images?recordId=${encodeURIComponent(started[0])}`, { scroll: false });
      return true;
    } catch (error) { fail(error); return false; }
    finally { submitLock.current = false; setBusy(false); }
  }
  async function generateFromImage(image: ImageFile, instruction: string, profileId: string, size: string, ownerRecordId?: string) {
    if (dirty && !confirmDiscardUnsavedChanges("生成修改图会替换当前未生成的输入，是否继续？")) return false;
    const ownerId = ownerRecordId || (record?.images.some((item) => item.id === image.id) ? record.id : [...boardRecords, ...records].find((item) => item.thumbnail?.id === image.id)?.id);
    const next: ImageGenerationInput = { ...form, profileId, size, count: 1, canvasId, prompt: `基于 ${imageMentionToken(image.id, "来源图片")} 修改：${instruction}`, referenceIds: [image.id], parentRecordId: ownerId, parentImageId: ownerId ? image.id : undefined };
    const success = await generate(next);
    if (success) { setForm(next); setReferences([image]); }
    return success;
  }
  async function upload(files: File[], mention = true) {
    if (!files.length || uploadLock.current || submitLock.current) return;
    if (form.referenceIds.length + files.length > 6) { setError("最多使用 6 张参考图，请先移除多余图片。"); return; }
    if (files.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024)) { setError("参考图仅支持 PNG、JPEG、WebP，每张不能超过 10MB。"); return; }
    uploadLock.current = true; formTouched.current = true; setUploading(true); setError("");
    try {
      const data = await uploadImageReferences(files);
      setReferences((current) => [...current, ...data.references]);
      setForm((current) => ({ ...current, referenceIds: [...current.referenceIds, ...data.references.map((ref) => ref.id)], prompt: mention ? data.references.reduce((prompt, ref) => appendImageMention(prompt, ref.id, ref.name), current.prompt) : current.prompt }));
      return data.references;
    } catch (error) { fail(error); }
    finally { uploadLock.current = false; setUploading(false); }
  }
  function addReference(image: ImageFile, mention = true) {
    if (uploadLock.current || submitLock.current) return false;
    if (!form.referenceIds.includes(image.id) && form.referenceIds.length >= 6) { setError("本次最多使用 6 张参考图，请先移除一张。"); return false; }
    if (references.some((ref) => ref.id === image.id)) {
      if (mention) updateForm((current) => ({ ...current, prompt: appendImageMention(current.prompt, image.id, image.name) }));
      return true;
    }
    if (form.referenceIds.length >= 6) { setError("本次最多使用 6 张参考图，请先移除一张。"); return false; }
    formTouched.current = true;
    setReferences((current) => [...current, image]);
    setForm((current) => ({ ...current, referenceIds: [...current.referenceIds, image.id], prompt: mention ? appendImageMention(current.prompt, image.id, image.name) : current.prompt }));
    return true;
  }
  function removeReference(referenceId: string) {
    if (uploadLock.current || submitLock.current) return false;
    formTouched.current = true;
    setReferences((current) => current.filter((ref) => ref.id !== referenceId));
    setForm((current) => ({ ...current, referenceIds: current.referenceIds.filter((ref) => ref !== referenceId), prompt: removeImageMention(current.prompt, referenceId), parentImageId: current.parentImageId === referenceId ? undefined : current.parentImageId }));
    return true;
  }
  async function cancel(taskId: string) {
    if (submitLock.current) return;
    submitLock.current = true;
    setBusy(true); setError("");
    try {
      const target = jobs.find((entry) => entry.id === taskId && (entry.status === "running" || entry.status === "queued"));
      if (target) await cancelTask(target.id);
    } catch (error) { fail(error); } finally { submitLock.current = false; setBusy(false); }
  }
  async function loadMore(board = false) {
    if (moreLock.current) return;
    moreLock.current = true; setMoreLoading(true);
    const revision = board ? boardRevision.current : listRevision.current;
    try {
      const data = await getImageRecords(board ? boardRecords.length : records.length, board ? canvasId : undefined);
      if (revision !== (board ? boardRevision.current : listRevision.current)) return;
      const update = (current: ImageGenerationSummary[]) => [...current, ...data.records.filter((item) => !current.some((existing) => existing.id === item.id))];
      if (board) boardLimit.current.count = Math.max(boardLimit.current.count, boardRecords.length + data.records.length);
      else listLimit.current = Math.max(listLimit.current, records.length + data.records.length);
      if (board) { setBoardRecords(update); setBoardTotal(data.total); } else { setRecords(update); setTotal(data.total); }
    } catch (error) { fail(error); } finally { moreLock.current = false; setMoreLoading(false); }
  }
  async function deleteRecords(input: { action: "delete"; id: string } | { action: "clear-failed" }) {
    if (deleteLock.current) return;
    deleteLock.current = true; setDeleting(true); setError("");
    try {
      const result = await deleteImageGenerationRecords(input);
      const removed = new Set(result.deleted);
      setRecords((current) => current.filter((item) => !removed.has(item.id)));
      setBoardRecords((current) => current.filter((item) => !removed.has(item.id)));
      if (removed.has(id)) { setRecord(null); router.replace("/images", { scroll: false }); }
      setDeletion({ message: result.deleted.length ? `已删除 ${result.deleted.length} 条记录，原图保留` : "没有可清理的失败记录", operationId: result.trashOperationId });
      await refresh(); await refreshBoard();
      return result.deleted;
    } catch (reason) { fail(reason); }
    finally { deleteLock.current = false; setDeleting(false); }
  }
  async function undoDelete() {
    if (!deletion?.operationId || deleteLock.current) return;
    deleteLock.current = true; setDeleting(true);
    try { await restoreLibraryTrashOperation(deletion.operationId); setDeletion(null); await refresh(); await refreshBoard(); }
    catch (reason) { fail(reason); }
    finally { deleteLock.current = false; setDeleting(false); }
  }
  function updateForm(action: React.SetStateAction<ImageGenerationInput>) {
    formTouched.current = true; setError("");
    setForm((current) => {
      const next = typeof action === "function" ? action(current) : action;
      if (next.prompt === current.prompt) return next;
      const referenceIds = [...new Set(Array.from(next.prompt.matchAll(imageMentionPattern()), (match) => match[2]))];
      return { ...next, referenceIds, parentImageId: next.parentImageId && referenceIds.includes(next.parentImageId) ? next.parentImageId : undefined };
    });
  }
  return { submissionKey: batchIds.join("|"), reproduce, addResultReferences, multiModels, setMultiModels, batchJobs, deleting, deletion, deleteRecords, undoDelete, id, canvasId, config, form, setForm: updateForm, references: references.filter((ref) => form.referenceIds.includes(ref.id)), availableReferences: references, recordReferences, records, boardRecords, boardTotal, boardLoading, total, record: record?.id === id ? record : null, job, jobs, error, fail, busy, uploading, loading, detailLoading, moreLoading, dirty, active, select, newRecord, generate, generateFromImage, upload, addReference, removeReference, cancel, refresh, refreshBoard, loadMore };
}
