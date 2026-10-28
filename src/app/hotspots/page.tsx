"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Newspaper, Sparkles } from "lucide-react";
import { NewsNowDiscovery } from "./NewsNowDiscovery";

const RadarAnalysis = dynamic(() => import("./TrendRadarReport"), {
  loading: () => <p role="status">正在读取 TrendRadar 报告…</p>,
});

export default function HotspotsPage() {
  return <Suspense fallback={<div className="page" role="status">正在打开热点雷达…</div>}><RadarWorkspace /></Suspense>;
}

function RadarWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // 保留既有 topics/news 深链接；无参数时进入 TrendRadar 报告。
  const analysis = params.get("view") !== "discover";
  function select(view: "discover" | "topics") {
    const next = new URLSearchParams(params.toString());
    next.set("view", view);
    next.delete("item");
    next.delete("page");
    router.replace(`${pathname}?${next}`, { scroll: false });
  }
  const navigation = <nav className="radar-view-toolbar radar-compact-nav" aria-label="热点雷达内容">
      <div className="radar-content-tabs">
        <button aria-pressed={!analysis} onClick={() => select("discover")}><Newspaper size={16} />资讯发现</button>
        <button aria-pressed={analysis} onClick={() => select("topics")}><Sparkles size={16} />TrendRadar 报告</button>
      </div>
    </nav>;
  return <div className={`page radar-page${analysis ? "" : " radar-discovery-page"}`}>
    {analysis ? <>{navigation}<RadarAnalysis /></> : <NewsNowDiscovery navigation={navigation} />}
  </div>;
}
