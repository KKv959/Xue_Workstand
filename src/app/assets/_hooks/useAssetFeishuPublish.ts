"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { BusyState } from "../_components/asset-view-utils";
import { publishFeishuDocument } from "@/lib/client";

type FeishuResult = {
  title: string;
  url: string;
};

type UseAssetFeishuPublishInput = {
  activeTitle: string;
  setBusy: Dispatch<SetStateAction<BusyState>>;
  setNotice: Dispatch<SetStateAction<string>>;
};

export function useAssetFeishuPublish({ activeTitle, setBusy, setNotice }: UseAssetFeishuPublishInput) {
  const [feishuResult, setFeishuResult] = useState<FeishuResult | null>(null);

  const handlePublishAssetText = useCallback(async (kind: "comments" | "danmaku", items: string[], emptyMessage: string) => {
    if (!items.length) return;
    setBusy(kind === "comments" ? "feishu-comments" : "feishu-danmaku");
    setNotice("");
    try {
      const result = await publishFeishuDocument({
        title: `${activeTitle}-${kind === "comments" ? "评论" : "弹幕"}`,
        content: items.join("\n")
      });
      setFeishuResult({ title: result.title, url: result.url });
      setNotice("已导出到飞书文档。");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : emptyMessage);
    } finally {
      setBusy("");
    }
  }, [activeTitle, setBusy, setNotice]);

  return {
    feishuResult,
    handlePublishAssetText,
    setFeishuResult
  };
}
