import { TranscriptStatus } from "@/lib/types";

const labels: Record<TranscriptStatus, string> = {
  not_started: "未转写",
  pending: "待转写",
  transcribing: "转写中",
  failed: "转写失败",
  completed: "已转写"
};

export function StatusPill({ status }: { status: TranscriptStatus }) {
  const busy = status === "transcribing";
  return (
    <span aria-busy={busy || undefined} className={`status-pill ${status}`} data-busy={busy ? "true" : undefined}>
      {labels[status] || status}
    </span>
  );
}
