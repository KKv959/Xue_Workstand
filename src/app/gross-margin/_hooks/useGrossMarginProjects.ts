"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedTasks } from "@/components/TaskProvider";
import { getGrossMarginProjectSource } from "@/lib/client";
import { getGrossMarginProjectSyncError } from "@/lib/gross-margin-projects";
import type { GrossMarginProjectSource } from "@/lib/types";

export function useGrossMarginProjects(enabled: boolean) {
  const { jobs, loading: tasksLoading, startTask } = useScopedTasks({ href: "/gross-margin", kinds: ["gross-margin-refresh"] });
  const [source, setSource] = useState<GrossMarginProjectSource | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState("");
  const started = useRef(false);
  const startingRef = useRef(false);
  const observed = useRef(new Set<string>());
  const projectJobs = jobs.filter(job => job.resultRef?.href === "/gross-margin" || job.href === "/gross-margin");
  const latestJob = projectJobs[0];
  const syncJob = projectJobs.find(job => job.status === "queued" || job.status === "running");

  const refresh = useCallback(async () => {
    if (startingRef.current || syncJob) return;
    startingRef.current = true;
    setStarting(true);
    setError("");
    try {
      const job = await startTask({ kind: "gross-margin-refresh", href: "/gross-margin", input: { syncProjects: true } });
      setJobId(job.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步当月项目报价失败，请重试");
    } finally { startingRef.current = false; setStarting(false); }
  }, [startTask, syncJob]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getGrossMarginProjectSource(controller.signal).then(setSource).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取项目报价失败");
    });
    return () => controller.abort();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !source || tasksLoading || started.current) return;
    started.current = true;
    if (syncJob) setJobId(syncJob.id);
    else if (latestJob?.status === "failed" && (!source.fetchedAt || Date.parse(source.fetchedAt) < Date.parse(latestJob.updatedAt))) setJobId(latestJob.id);
  }, [enabled, latestJob, source, syncJob, tasksLoading]);

  useEffect(() => {
    const job = jobs.find(item => item.id === (jobId || syncJob?.id));
    if (!source || !job || job.status === "queued" || job.status === "running" || observed.current.has(job.id)) return;
    observed.current.add(job.id);
    if (job.status !== "completed") {
      setError(getGrossMarginProjectSyncError(job, source));
      return;
    }
    // 任务列表每次进度更新都会换引用，不能在依赖变化时取消这一次缓存读取。
    getGrossMarginProjectSource().then(result => { setSource(result); setError(""); }).catch(cause => {
      setError(cause instanceof Error ? cause.message : "读取同步后的项目报价失败");
    });
  }, [jobs, jobId, source, syncJob?.id]);

  return { source, error, loading: starting || Boolean(syncJob), refresh };
}
