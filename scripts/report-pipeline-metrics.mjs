import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const libraryDir = path.resolve(process.env.STYLE_LIBRARY_DIR || "style-library");
const jobsDir = path.join(libraryDir, "jobs");
const jsonOutput = process.argv.includes("--json");

const files = (await readdir(jobsDir).catch(() => [])).filter((file) => file.endsWith(".json"));
const jobs = [];
for (const file of files) {
  try {
    const job = JSON.parse(await readFile(path.join(jobsDir, file), "utf8"));
    if (job && typeof job === "object") jobs.push(job);
  } catch {
    // A corrupt job is reported by the normal consistency checks; this report stays best-effort.
  }
}

const duration = (start, end) => {
  const value = Date.parse(end || "") - Date.parse(start || "");
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const percentile = (values, rate) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * rate)] : null;
};
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const completedJobs = jobs.filter((job) => terminal.has(job.status));
const byKind = new Map();
const byStatus = new Map();
const byStage = new Map();
const failureReasons = new Map();

for (const job of jobs) {
  byStatus.set(job.status, (byStatus.get(job.status) || 0) + 1);
  if (!byKind.has(job.kind)) byKind.set(job.kind, []);
  byKind.get(job.kind).push(job);
  if (job.status === "failed") {
    const reason = String(job.error || job.message || "未记录错误")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    failureReasons.set(`${job.kind}｜${reason}`, (failureReasons.get(`${job.kind}｜${reason}`) || 0) + 1);
  }

  const events = Array.isArray(job.events) ? job.events : [];
  for (let index = 0; index + 1 < events.length; index += 1) {
    const current = events[index];
    const next = events[index + 1];
    if (!current?.stage) continue;
    const ms = duration(current.at, next.at);
    if (ms === null) continue;
    if (!byStage.has(current.stage)) byStage.set(current.stage, []);
    byStage.get(current.stage).push(ms);
  }
}

const makeDurationSummary = (rows) => {
  const queue = rows.map((job) => {
    const running = (job.events || []).find((event) => event.status === "running");
    return duration(job.createdAt, running?.at);
  });
  const run = rows.map((job) => {
    const running = (job.events || []).find((event) => event.status === "running");
    return duration(running?.at, job.completedAt || job.updatedAt);
  });
  return {
    count: rows.length,
    queueP50Ms: percentile(queue, 0.5),
    queueP90Ms: percentile(queue, 0.9),
    runP50Ms: percentile(run, 0.5),
    runP90Ms: percentile(run, 0.9)
  };
};

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "style-library/jobs",
  total: jobs.length,
  terminal: completedJobs.length,
  status: Object.fromEntries([...byStatus].sort()),
  byKind: Object.fromEntries([...byKind].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, rows]) => [kind, makeDurationSummary(rows)])),
  stages: Object.fromEntries([...byStage].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).slice(0, 20).map(([stage, values]) => [stage, {
    count: values.length,
    totalMs: values.reduce((total, value) => total + value, 0),
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9)
  }])),
  failureReasons: Object.fromEntries([...failureReasons].sort((a, b) => b[1] - a[1]).slice(0, 20))
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const format = (ms) => ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`;
  console.log("全链路指标报告（基于已持久化任务历史）");
  console.log(`任务：${report.total} 条；终态：${report.terminal} 条`);
  const statusText = Object.entries(report.status).map(([key, value]) => `${key} ${value}`).join("，") || "-";
  console.log(`状态：${statusText}`);
  console.log("");
  console.log("按任务类型（排队 p50/p90；执行 p50/p90）：");
  for (const [kind, summary] of Object.entries(report.byKind)) {
    console.log(`- ${kind}: ${summary.count} 条；${format(summary.queueP50Ms)}/${format(summary.queueP90Ms)}；${format(summary.runP50Ms)}/${format(summary.runP90Ms)}`);
  }
  console.log("");
  console.log("阶段耗时 Top 20：");
  for (const [stage, summary] of Object.entries(report.stages)) {
    console.log(`- ${stage}: ${summary.count} 次；累计 ${format(summary.totalMs)}；p50 ${format(summary.p50Ms)}；p90 ${format(summary.p90Ms)}`);
  }
  console.log("");
  console.log("失败原因 Top 20：");
  for (const [reason, count] of Object.entries(report.failureReasons)) console.log(`- ${count} 次｜${reason}`);
}
