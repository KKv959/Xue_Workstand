import { apiJson } from "@/lib/api-route";
import { NEWSNOW_URL, type NewsNowStatus } from "@/lib/newsnow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return apiJson(async (): Promise<NewsNowStatus> => {
    try {
      const response = await fetch(NEWSNOW_URL, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(4000)]),
      });
      if (!response.ok || !(await response.text()).includes("NewsNow")) {
        return { available: false, message: "NewsNow 服务响应异常，请检查容器日志后重试。" };
      }
      return { available: true, message: "NewsNow 服务已连接" };
    } catch {
      // 健康检查将连接失败显式返回给页面，不替代资讯数据。
      return { available: false, message: "无法连接 NewsNow，请打开 Docker Desktop 并启动 NewsNow 容器后重试。" };
    }
  }, { fallbackMessage: "检查 NewsNow 连接失败，请重试。" });
}
