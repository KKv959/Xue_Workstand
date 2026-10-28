// 本页查询参数只控制客户端选择。Next 原生 History 集成会同步 useSearchParams，避免 RSC 往返。
export function updateLibraryUrl(updates: Record<string, string | null>, history: "replace" | "push" = "replace") {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href === window.location.href) return;
  window.history[history === "push" ? "pushState" : "replaceState"](null, "", `${url.pathname}${url.search}${url.hash}`);
}
