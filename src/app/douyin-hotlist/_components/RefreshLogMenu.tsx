import { useId, useState } from "react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { ChevronDown, Clock3 } from "lucide-react";
import {
  formatLogTime,
  getRefreshLogStatusLabel,
  type RefreshLogEntry,
  type RefreshLogGroup,
  type RefreshLogGroupKind
} from "../_lib/douyin-hotlist-model";

export function RefreshLogMenu({
  error,
  loading,
  logs
}: {
  error: string;
  loading: boolean;
  logs: RefreshLogEntry[];
}) {
  const latestLog = logs[0];
  const latestTime = latestLog ? formatLogTime(latestLog.at) : "";

  return (
    <div className="douyin-hotlist-refresh-log">
      <DialogTrigger>
        <Button
          aria-label={latestTime ? `查看刷新日志，上次 ${latestTime}` : "查看刷新日志"}
          className="btn douyin-hotlist-refresh-log-trigger"
        >
          <Clock3 aria-hidden="true" size={13} />
          <span>刷新日志</span>
          {latestTime ? <small className="douyin-hotlist-refresh-log-time">{latestTime}</small> : null}
        </Button>
        <Popover className="workbench-select-popover douyin-hotlist-log-popover" placement="bottom end" offset={8}>
          <Dialog className="douyin-hotlist-refresh-log-panel" aria-label="刷新日志">
            <div className="douyin-hotlist-refresh-log-head">
              <strong>刷新日志</strong>
              <span>所有浏览器共享抓取结果，失败会保留明细</span>
            </div>
            {error ? <p className="douyin-hotlist-refresh-log-error" role="alert">{error}</p> : null}
            {logs.length ? (
              <ol>
                {logs.map((log) => <RefreshLogItem key={log.id} log={log} />)}
              </ol>
            ) : !error ? (
              <p>{loading ? "正在读取共享刷新日志…" : "暂无记录，下一次手动抓取后会写在这里。"}</p>
            ) : null}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}

function RefreshLogItem({ log }: { log: RefreshLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const hasDetails = Boolean(log.groups?.length);
  const summary = <RefreshLogSummary log={log} />;

  return (
    <li className={`tone-${log.status}`}>
      {hasDetails ? (
        <div className={`douyin-hotlist-refresh-log-entry${expanded ? " is-open" : ""}`}>
          <button
            aria-controls={detailsId}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {summary}
            <span className="douyin-hotlist-refresh-log-disclosure">
              {getDisclosureLabel(log)}
              <ChevronDown aria-hidden="true" size={13} />
            </span>
          </button>
          {expanded ? (
            <div className="douyin-hotlist-refresh-log-details" id={detailsId}>
              {log.groups?.map((group, index) => (
                <RefreshLogGroupBlock group={group} key={`${group.kind}-${group.reason || ""}-${index}`} />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="douyin-hotlist-refresh-log-entry-static">{summary}</div>
      )}
    </li>
  );
}

function RefreshLogSummary({ log }: { log: RefreshLogEntry }) {
  return (
    <>
      <span className="douyin-hotlist-refresh-log-meta">
        <span>{formatLogTime(log.at)}</span>
        <span>{log.automatic ? "自动" : "手动"}</span>
        <span>{getRefreshLogStatusLabel(log.status)}</span>
      </span>
      <span className="douyin-hotlist-refresh-log-summary">{log.text}</span>
    </>
  );
}

function RefreshLogGroupBlock({ group }: { group: RefreshLogGroup }) {
  return (
    <div className={`douyin-hotlist-refresh-log-group kind-${group.kind}`}>
      <div className="douyin-hotlist-refresh-log-group-head">
        <strong>{getGroupLabel(group.kind)}</strong>
        <span>{group.accounts.length} 个</span>
      </div>
      <p>{group.accounts.join("、")}</p>
      {group.reason ? <small>{group.reason}</small> : null}
    </div>
  );
}

function getDisclosureLabel(log: RefreshLogEntry) {
  if (!log.groups?.length) return "查看明细";
  const counts = new Map<RefreshLogGroupKind, number>();
  log.groups.forEach((group) => counts.set(group.kind, (counts.get(group.kind) || 0) + group.accounts.length));
  const parts: string[] = [];
  if (counts.get("failed")) parts.push(`${counts.get("failed")} 失败`);
  if (counts.get("recovered")) parts.push(`${counts.get("recovered")} 已恢复`);
  if (counts.get("unchanged")) parts.push(`${counts.get("unchanged")} 无变化`);
  return `查看明细 · ${parts.join(" / ")}`;
}

function getGroupLabel(kind: RefreshLogGroupKind) {
  if (kind === "failed") return "失败账号";
  if (kind === "recovered") return "重试已恢复";
  return "无变化";
}
