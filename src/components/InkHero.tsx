import type { ReactNode } from "react";
import { AnimatedNumber } from "./AnimatedNumber";

export type InkStat = {
  label: string;
  value: number;
  /** signal：需要注意的数量；positive / warning / danger：毛利等带好坏的数值。 */
  tone?: "signal" | "positive" | "warning" | "danger";
  format?: (value: number) => string;
  hint?: string;
};

/** 紧凑状态栏：页面名称交给导航，保留语义标题、状态、统计与操作。 */
export function InkHero({ eyebrow, title, stats, actions, className = "" }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  stats?: InkStat[];
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`ink-hero ${className}`}>
      <h1 className="sr-only">{title}</h1>
      {eyebrow ? <span className="ink-hero-context">{eyebrow}</span> : null}
      {stats?.length ? (
        <dl className="ink-hero-stats" aria-live="polite">
          {stats.map((stat) => (
            <div key={stat.label} className={stat.tone ? `is-${stat.tone}` : ""} title={stat.hint}>
              <dt>{stat.label}</dt>
              <dd><AnimatedNumber value={stat.value} format={stat.format} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actions ? <div className="ink-hero-actions">{actions}</div> : null}
    </header>
  );
}
