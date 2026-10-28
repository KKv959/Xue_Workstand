import { getAccountDetail, getLibraryOverview, getTranscriptSnapshot } from "./storage";
import { filterLibraryAccounts, selectLibraryVideos } from "./library-selection";
import { canReadTranscript, makePreview } from "@/app/library/_components/library-view-utils";
import type { LibraryBootstrapResponse } from "./types";

export async function getLibraryBootstrap(params: URLSearchParams): Promise<LibraryBootstrapResponse> {
  const overview = await getLibraryOverview();
  const accounts = filterLibraryAccounts(overview.accounts, params.get("q") || "");
  const selected = accounts.find(account => account.id === params.get("account")) || accounts[0];
  if (!selected) return { overview, account: null, transcript: null };
  const account = await getAccountDetail(selected.platform, selected.id, { includeStyle: true });
  const { selectedVideo } = selectLibraryVideos(account, params);
  if (!selectedVideo || !canReadTranscript(selectedVideo)) return { overview, account, transcript: null };
  try {
    const snapshot = await getTranscriptSnapshot(account.platform, account.id, selectedVideo.id);
    if (!snapshot.transcript.trim()) throw new Error("这份原稿为空或文件缺失，请重新转写或检查资料库文件。");
    return { overview, account, transcript: { videoId: selectedVideo.id, preview: makePreview(snapshot.transcript), revision: snapshot.revision } };
  } catch (error) {
    // 单份坏稿不阻塞账号列表；客户端在原稿区域明确展示错误。
    return { overview, account, transcript: { videoId: selectedVideo.id, preview: "", revision: selectedVideo.transcriptRevision || null,
      error: error instanceof Error ? error.message : "读取转写稿失败，请重试" } };
  }
}
