"use client";

import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Clipboard,
  ExternalLink,
  FileText,
  Hash,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  Music,
  Paperclip,
  Search,
  Sparkles,
  Video
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useFeedback } from "@/components/FeedbackProvider";
import { useScopedTasks } from "@/components/TaskProvider";
import {
  downloadSingleVideoAsset,
  uploadWriterSourceFiles,
  type SingleVideoAssetKind,
  type SingleVideoTranscribeResult
} from "@/lib/client";
import type { PublishCopyCandidate, PublishCopyResult, PublishCopyTargetPlatform } from "@/lib/publish-copy-types";
import { appendWriterSourceFiles, WRITER_SOURCE_FILE_ACCEPT } from "@/lib/source-file-import";

type BusyState = "" | "transcribe" | "download" | "publish-copy";
type NoticeTone = "success" | "info" | "error";

const downloadOptions: Array<{
  kind: SingleVideoAssetKind;
  label: string;
  icon: LucideIcon;
}> = [
  { kind: "video", label: "视频", icon: Video },
  { kind: "cover", label: "封面", icon: ImageIcon },
  { kind: "audio", label: "音频", icon: Music }
];

const publishPlatformOptions: Array<{
  value: PublishCopyTargetPlatform;
  label: string;
}> = [
  { value: "both", label: "双平台" },
  { value: "bilibili", label: "B站" },
  { value: "douyin", label: "抖音" }
];

export default function ToolsPage() {
  const { notify } = useFeedback();
  const { activeJobs, recentJobs, startTask } = useScopedTasks({
    href: "/tools",
    kinds: ["single-video-transcribe", "publish-copy"]
  });
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<SingleVideoTranscribeResult | null>(null);
  const [downloadingKind, setDownloadingKind] = useState<SingleVideoAssetKind | "">("");
  const [publishSourceText, setPublishSourceText] = useState("");
  const [publishTopicHint, setPublishTopicHint] = useState("");
  const [publishPlatform, setPublishPlatform] = useState<PublishCopyTargetPlatform>("both");
  const [publishResult, setPublishResult] = useState<PublishCopyResult | null>(null);
  const [publishSourceDragActive, setPublishSourceDragActive] = useState(false);
  const [publishSourceImporting, setPublishSourceImporting] = useState(false);
  const [busy, setBusy] = useState<BusyState>("");
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("success");
  const [activeJobId, setActiveJobId] = useState("");
  const publishSourceDragDepthRef = useRef(0);
  const publishSourceFileInputRef = useRef<HTMLInputElement>(null);

  const cleanUrl = url.trim();
  const cleanPublishSourceText = publishSourceText.trim();
  const noticeIsError = noticeTone === "error";

  async function handleTranscribe() {
    if (!cleanUrl || busy) return;
    setBusy("transcribe");
    setNotice("");
    try {
      const job = await startTask({
        kind: "single-video-transcribe",
        href: "/tools",
        input: { url: cleanUrl }
      });
      setActiveJobId(job.id);
      setNotice("提取任务已加入任务中心，可离开页面继续处理。");
      setNoticeTone("info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "单条视频文案提取失败";
      setNotice(message);
      setNoticeTone("error");
      notify({ tone: "error", message });
      setBusy("");
    }
  }

  async function handleDownload(kind: SingleVideoAssetKind) {
    if (!cleanUrl || busy) return;
    setBusy("download");
    setDownloadingKind(kind);
    setNotice("");
    try {
      const response = await downloadSingleVideoAsset({ url: cleanUrl, kind });
      const message = `已下载：${response.fileName}`;
      setNotice(message);
      setNoticeTone("success");
      notify({ tone: "success", message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "下载失败";
      setNotice(message);
      setNoticeTone("error");
      notify({ tone: "error", message });
    } finally {
      setBusy("");
      setDownloadingKind("");
    }
  }

  async function handleGeneratePublishCopy() {
    if (!cleanPublishSourceText || busy || publishSourceImporting) return;
    setBusy("publish-copy");
    setNotice("");
    try {
      const job = await startTask({
        kind: "publish-copy",
        href: "/tools",
        input: {
          platform: publishPlatform,
          sourceText: cleanPublishSourceText,
          topicHint: publishTopicHint.trim() || undefined,
          candidateCount: 6
        }
      });
      setActiveJobId(job.id);
      setNotice("生成任务已加入任务中心，可离开页面继续处理。");
      setNoticeTone("info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "标题和发布文案生成失败";
      setNotice(message);
      setNoticeTone("error");
      notify({ tone: "error", message });
      setBusy("");
    }
  }

  const handlePublishSourceFiles = useCallback(async (files: File[]) => {
    if (!files.length || publishSourceImporting) return;
    setPublishSourceImporting(true);
    try {
      const response = await uploadWriterSourceFiles(files);
      setPublishSourceText((current) => appendWriterSourceFiles(current, response.files));
      setPublishResult(null);
      const truncatedCount = response.files.filter((file) => file.truncated).length;
      notify({
        tone: "success",
        message: `已导入 ${response.files.length} 个文件${truncatedCount ? `，其中 ${truncatedCount} 个过长文件已截取` : ""}。`
      });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "导入内容原稿失败" });
    } finally {
      setPublishSourceImporting(false);
      setPublishSourceDragActive(false);
      publishSourceDragDepthRef.current = 0;
      if (publishSourceFileInputRef.current) publishSourceFileInputRef.current.value = "";
    }
  }, [notify, publishSourceImporting]);

  const handlePublishSourceDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (publishSourceImporting || !event.dataTransfer.types.includes("Files")) return;
    publishSourceDragDepthRef.current += 1;
    setPublishSourceDragActive(true);
  }, [publishSourceImporting]);

  const handlePublishSourceDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    publishSourceDragDepthRef.current = Math.max(0, publishSourceDragDepthRef.current - 1);
    if (!publishSourceDragDepthRef.current) setPublishSourceDragActive(false);
  }, []);

  const handlePublishSourceDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    publishSourceDragDepthRef.current = 0;
    setPublishSourceDragActive(false);
    if (publishSourceImporting) return;
    void handlePublishSourceFiles(Array.from(event.dataTransfer.files));
  }, [handlePublishSourceFiles, publishSourceImporting]);

  useEffect(() => {
    if (!activeJobId) return;
    const job = [...activeJobs, ...recentJobs].find((item) => item.id === activeJobId);
    if (!job || job.status === "queued" || job.status === "running") return;

    setActiveJobId("");
    setBusy("");
    if (job.status !== "completed" || !job.result) {
      const message = job.error || job.message || "工具任务未完成。";
      setNotice(message);
      setNoticeTone("error");
      return;
    }

    if (job.kind === "single-video-transcribe") {
      const response = job.result as SingleVideoTranscribeResult;
      setResult(response);
      const message = response.fallback ? response.fallbackReason || "已提取可用文本。" : "文案已提取。";
      setNotice(message);
      setNoticeTone(response.fallback ? "info" : "success");
      return;
    }

    const response = job.result as PublishCopyResult;
    setPublishResult(response);
    const message = response.fallback
      ? response.fallbackReason || "已生成可编辑标题和发布文案，请检查生成依据。"
      : `已生成 ${response.candidates.length} 组标题和发布文案。`;
    setNotice(message);
    setNoticeTone(response.fallback ? "info" : "success");
  }, [activeJobId, activeJobs, recentJobs]);

  function handleUrlChange(nextUrl: string) {
    setUrl(nextUrl);
    setResult(null);
  }

  function moveTranscriptToPublishCopy() {
    if (!result?.text.trim()) return;
    setPublishSourceText(result.text);
    setPublishResult(null);
    document.getElementById("tools-publish-source-text")?.focus();
    setNotice("");
  }

  async function copyResultText() {
    if (!result?.text.trim()) return;
    await navigator.clipboard.writeText(result.text);
    notify({ tone: "success", message: "文案已复制。" });
  }

  async function copyPublishCandidate(candidate: PublishCopyCandidate) {
    await navigator.clipboard.writeText(`${candidate.title}\n\n${candidate.caption}`);
    notify({ tone: "success", message: "标题和发布文案已复制。" });
  }

  return (
    <div className="page tools-page">
      <div className="tools-modules">
        {renderVideoWorkspace()}
        {renderPublishWorkspace()}
      </div>

      {notice ? (
        <div className={noticeIsError ? "error" : "notice"} role={noticeIsError ? "alert" : "status"}>
          {notice}
        </div>
      ) : null}
    </div>
  );

  function renderVideoWorkspace() {
    return (
      <section id="tools-video" className="panel tools-module tools-video-workspace" aria-label="视频提取与下载" aria-busy={busy === "transcribe" || busy === "download"}>
        <div className="tools-control-pane">
          <PaneHeading index="01" icon={Video} title="视频提取" description="一个链接，提取文案与素材。" />

          <VideoLinkField url={url} setUrl={handleUrlChange} />

          <div className="tools-action-block">
            <span className="tools-label">视频文案</span>
            <button
              className="btn primary tools-primary-action"
              disabled={!cleanUrl || Boolean(busy)}
              type="button"
              onClick={() => void handleTranscribe()}
              aria-busy={busy === "transcribe"}
            >
              {busy === "transcribe" ? <Loader2 className="tools-spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
              {busy === "transcribe" ? "提取中" : "提取视频文案"}
            </button>
          </div>

          <div className="tools-video-preview" aria-live="polite">
            {result ? (
              <>
                {result.fallback ? <p className="notice">{result.fallbackReason || "使用了备用提取结果，请检查文稿。"}</p> : null}
                <div className="tools-video-result">
                  <VideoSourceSummary result={result} />
                  <div className="tools-transcript-card">
                    <div className="tools-transcript-head">
                      <div>
                        <span className="tools-label">提取文案</span>
                        <strong>{result.text.length.toLocaleString("zh-CN")} 字</strong>
                      </div>
                      <div className="tools-result-actions">
                        <button className="btn compact" type="button" onClick={() => void copyResultText()}>
                          <Clipboard size={15} aria-hidden="true" />
                          复制
                        </button>
                        <button className="btn primary compact" type="button" onClick={moveTranscriptToPublishCopy}>
                          <Sparkles size={15} aria-hidden="true" />
                          用于标题与发布
                          <ArrowRight size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <p className="tools-transcript-preview">{result.text}</p>
                    <details className="tools-transcript-details">
                      <summary>查看完整文稿</summary>
                      <textarea
                        aria-label="提取结果文案"
                        autoComplete="off"
                        className="tools-result-text"
                        name="transcribeResult"
                        value={result.text}
                        readOnly
                      />
                    </details>
                  </div>
                </div>
              </>
            ) : (
              <div className="tools-video-empty">
                <FileText size={24} aria-hidden="true" />
                <strong>提取后，在这里查看文案</strong>
                <p>支持复制，或填入右侧生成标题与发布文案。</p>
              </div>
            )}
          </div>

          <div className="tools-action-block">
            <span className="tools-label">下载素材 <small>有链接即可下载，无需先提取文案</small></span>
            <div className="tools-download-actions">
              {downloadOptions.map((option) => {
                const Icon = option.icon;
                const active = busy === "download" && downloadingKind === option.kind;
                return (
                  <button
                    className="btn"
                    disabled={!cleanUrl || Boolean(busy)}
                    key={option.kind}
                    type="button"
                    onClick={() => void handleDownload(option.kind)}
                    aria-busy={active}
                  >
                    {active ? <Loader2 className="tools-spin" size={16} aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
                    {active ? "下载中" : option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    );
  }

  function renderPublishWorkspace() {
    return (
      <section id="tools-publish" className="panel tools-module tools-publish-workspace" aria-label="标题与发布文案" aria-busy={busy === "publish-copy"}>
        <div className="tools-control-pane">
          <PaneHeading index="02" icon={Sparkles} title="标题与发布" description="把内容，变成让人想点开的表达。" />

          <div className="tools-inline-group">
            <span className="tools-label">发布平台</span>
            <div className="segmented tools-platform-tabs" role="group" aria-label="发布平台">
              {publishPlatformOptions.map((option) => {
                const active = publishPlatform === option.value;
                return (
                  <button
                    className={active ? "active" : ""}
                    key={option.value}
                    type="button"
                    onClick={() => setPublishPlatform(option.value)}
                    aria-pressed={active}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field tools-publish-source-field" aria-busy={publishSourceImporting}>
            <div className="tools-source-label-row">
              <label htmlFor="tools-publish-source-text">内容原稿</label>
              <button
                aria-busy={publishSourceImporting}
                className="btn small ghost tools-source-file-button"
                disabled={publishSourceImporting}
                onClick={() => publishSourceFileInputRef.current?.click()}
                title="支持 TXT、Markdown、CSV、JSON、HTML、字幕、DOCX 和 PDF"
                type="button"
              >
                <Paperclip aria-hidden="true" size={14} />
                {publishSourceImporting ? "导入中" : "添加文件"}
              </button>
              <input
                accept={WRITER_SOURCE_FILE_ACCEPT}
                aria-label="选择内容原稿文件"
                className="tools-source-file-input"
                disabled={publishSourceImporting}
                multiple
                onChange={(event) => void handlePublishSourceFiles(Array.from(event.target.files || []))}
                ref={publishSourceFileInputRef}
                type="file"
              />
            </div>
            <div
              className={`tools-publish-source-dropzone ${publishSourceDragActive ? "drag-active" : ""}`}
              onDragEnter={handlePublishSourceDragEnter}
              onDragLeave={handlePublishSourceDragLeave}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={handlePublishSourceDrop}
            >
              <textarea
                autoComplete="off"
                className="tools-source-textarea"
                id="tools-publish-source-text"
                name="publishSourceText"
                value={publishSourceText}
                onChange={(event) => {
                  setPublishSourceText(event.target.value);
                  setPublishResult(null);
                }}
                placeholder="粘贴口播稿、内容草稿或已提取的视频文案…"
              />
              {publishSourceDragActive ? (
                <div className="tools-source-drop-overlay" aria-hidden="true">
                  <Paperclip size={20} />
                  <strong>松开即可导入</strong>
                </div>
              ) : null}
            </div>
          </div>

          <label className="field">
            <span>选题关键词（可选）</span>
            <div className="tools-input-shell">
              <Hash size={16} aria-hidden="true" />
              <input
                autoComplete="off"
                name="publishTopicHint"
                value={publishTopicHint}
                onChange={(event) => {
                  setPublishTopicHint(event.target.value);
                  setPublishResult(null);
                }}
                placeholder="例如：低糖麦芽雪冰"
              />
            </div>
          </label>

          <button
            className="btn primary tools-primary-action"
            disabled={!cleanPublishSourceText || Boolean(busy) || publishSourceImporting}
            type="button"
            onClick={() => void handleGeneratePublishCopy()}
            aria-busy={busy === "publish-copy"}
          >
            {busy === "publish-copy" ? <Loader2 className="tools-spin" size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
            {busy === "publish-copy" ? "检索生成中" : "检索并生成 6 组"}
          </button>
        </div>

        {publishResult ? <div className="tools-result-pane" aria-live="polite">
          {publishResult.fallback ? <p className="notice">{publishResult.fallbackReason || "使用了备用生成结果，请检查生成依据。"}</p> : null}
          {publishResult?.candidates.length ? (
            <div className="tools-publish-results">
              <div className="tools-provenance-strip">
                <div>
                  <span>选题</span>
                  <strong>{publishResult.queryPlan.topic}</strong>
                </div>
                <div>
                  <span>参考样本</span>
                  <strong>{publishResult.research.referenceCount} 条</strong>
                </div>
                <div>
                  <span>生成模型</span>
                  <strong>{publishResult.usedModel || "本地规则"}</strong>
                </div>
              </div>

              <div className="tools-candidate-list">
                {publishResult.candidates.map((candidate, index) => (
                  <article className="tools-candidate-card" key={`${candidate.title}-${index}`}>
                    <div className="tools-candidate-head">
                      <span className="status-pill">{formatTargetPlatformLabel(candidate.platform)}</span>
                      <span>{candidate.angle || candidate.frameworkName || `候选 ${index + 1}`}</span>
                      <button
                        className="btn compact icon-only"
                        type="button"
                        aria-label={`复制候选 ${index + 1}`}
                        title="复制标题和发布文案"
                        onClick={() => void copyPublishCandidate(candidate)}
                      >
                        <Clipboard size={15} aria-hidden="true" />
                      </button>
                    </div>
                    <h3>{candidate.title}</h3>
                    <p>{candidate.caption}</p>
                    {candidate.frameworkName ? <small>框架：{candidate.frameworkName}</small> : null}
                  </article>
                ))}
              </div>

              <GenerationBasis result={publishResult} />
            </div>
          ) : null}
        </div> : null}
      </section>
    );
  }

}

function PaneHeading(input: { index: string; icon: LucideIcon; title: string; description: string }) {
  const Icon = input.icon;
  return (
    <div className="tools-pane-heading">
      <span className="tools-module-icon"><Icon size={22} strokeWidth={1.7} aria-hidden="true" /></span>
      <div><h2>{input.title}</h2><p>{input.description}</p></div>
      <span className="tools-module-number" aria-hidden="true">{input.index}</span>
    </div>
  );
}

function VideoLinkField(input: { url: string; setUrl: (url: string) => void }) {
  return (
    <label className="field">
      <span>视频链接</span>
      <div className="tools-input-shell">
        <LinkIcon size={16} aria-hidden="true" />
        <input
          autoComplete="off"
          name="videoUrl"
          type="url"
          value={input.url}
          onChange={(event) => input.setUrl(event.target.value)}
          placeholder="粘贴 B站或抖音视频链接"
        />
      </div>
    </label>
  );
}

function VideoSourceSummary(input: { result: SingleVideoTranscribeResult }) {
  const { result } = input;
  return (
    <div className="tools-source-summary">
      {result.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={result.coverUrl} alt={result.title ? `${result.title} 封面` : "视频封面"} height={180} loading="lazy" width={320} />
      ) : (
        <div className="tools-cover-placeholder">
          <ImageIcon size={22} aria-hidden="true" />
        </div>
      )}
      <div className="tools-source-copy">
        <span>{platformLabel(result.platform)}</span>
        <strong>{result.title || "未读取标题"}</strong>
        <small>{result.sourceAccountName || transcriptionSourceLabel(result.source)}</small>
      </div>
      {result.resolvedUrl ? (
        <a className="btn compact icon-only" href={result.resolvedUrl} target="_blank" rel="noreferrer" aria-label="打开视频来源" title="打开视频来源">
          <ExternalLink size={15} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function GenerationBasis(input: { result: PublishCopyResult }) {
  const { result } = input;
  return (
    <details className="tools-generation-basis">
      <summary>
        <span>生成依据</span>
        <small>{result.frameworks.length} 个框架 / {result.queryPlan.queries.length} 个检索词</small>
      </summary>
      <div className="tools-basis-content">
        <div className="tools-query-block">
          <span className="tools-label">实际检索词</span>
          <div className="tools-query-list">
            {result.queryPlan.queries.map((query) => (
              <span className="status-pill" key={query}>{query}</span>
            ))}
          </div>
        </div>
        <div className="tools-research-grid">
          <div className="tools-framework-list">
            {result.frameworks.map((framework) => (
              <div className="tools-framework-item" key={framework.name}>
                <strong>{framework.name}</strong>
                <span>标题：{framework.titlePattern}</span>
                <span>发布：{framework.captionPattern}</span>
                {framework.fitReason ? <small>{framework.fitReason}</small> : null}
              </div>
            ))}
          </div>
          <div className="tools-reference-list">
            {result.research.references.slice(0, 8).map((reference) => (
              <a href={reference.url} target="_blank" rel="noreferrer" key={`${reference.platform}-${reference.url}`}>
                <span>{formatPlatformLabel(reference.platform)}｜{reference.title}</span>
                <small>{formatReferenceMeta(reference)}</small>
              </a>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

function formatTargetPlatformLabel(platform: PublishCopyTargetPlatform) {
  if (platform === "both") return "双平台";
  return formatPlatformLabel(platform);
}

function platformLabel(platform: SingleVideoTranscribeResult["platform"]) {
  if (platform === "bilibili") return "B站";
  if (platform === "douyin") return "抖音";
  return "未知平台";
}

function formatPlatformLabel(platform: "bilibili" | "douyin") {
  return platform === "bilibili" ? "B站" : "抖音";
}

function formatReferenceMeta(reference: PublishCopyResult["research"]["references"][number]) {
  const stats = reference.stats || {};
  const items = [
    stats.views ? `播放 ${stats.views}` : "",
    stats.likes ? `赞 ${stats.likes}` : "",
    stats.comments ? `评 ${stats.comments}` : ""
  ].filter(Boolean);
  return items.length ? items.join(" / ") : reference.query;
}

function transcriptionSourceLabel(source: SingleVideoTranscribeResult["source"]) {
  if (source === "platform_subtitle") return "平台字幕";
  if (source === "volcengine") return "火山转写";
  return "标题兜底";
}
