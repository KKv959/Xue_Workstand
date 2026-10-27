import Link from "next/link";
import { ArrowRight, CircleDashed } from "lucide-react";

export function EmptyState({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <div className="panel empty-state-panel">
      <div className="panel-inner">
        <span className="empty-state-mark" aria-hidden="true">
          <CircleDashed size={17} />
        </span>
        <h2>{title}</h2>
        <p className="subtle">{body}</p>
        {action ? (
          <Link className="btn primary" href={action.href}>
            {action.label}
            <ArrowRight aria-hidden="true" size={15} />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
