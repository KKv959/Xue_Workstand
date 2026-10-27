"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { publishFeishuDocument } from "@/lib/client";

type FeishuResult = {
  title: string;
  url: string;
};

type UseFeishuPublishInput = {
  activeTitle?: string;
  lastContent: string;
  setBusy: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
};

export function useFeishuPublish({ activeTitle, lastContent, setBusy, setNotice }: UseFeishuPublishInput) {
  const [feishuResult, setFeishuResult] = useState<FeishuResult | null>(null);

  const handlePublishFeishu = useCallback(async () => {
    if (!lastContent) return;
    setBusy("feishu");
    setNotice("");
    try {
      const result = await publishFeishuDocument({
        title: `${activeTitle || "写作台"}｜${new Date().toLocaleDateString("zh-CN")}`,
        content: lastContent
      });
      setFeishuResult({ title: result.title, url: result.url });
      setNotice("已发布到飞书文档，可以在弹窗中打开。");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "发布飞书文档失败，请检查 lark-cli 登录状态和文件夹配置。");
    } finally {
      setBusy("");
    }
  }, [activeTitle, lastContent, setBusy, setNotice]);

  return {
    feishuResult,
    handlePublishFeishu,
    setFeishuResult
  };
}
