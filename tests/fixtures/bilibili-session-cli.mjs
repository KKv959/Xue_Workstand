import fs from "node:fs";
import vm from "node:vm";
// 模拟一个初始不在 B站的后台标签页：open 后才变成 www.bilibili.com，并记录打开过的地址。
const args = process.argv.slice(2);
const state = process.env.BILI_SESSION_STATE;
const opened = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : [];
const emit = (data) => console.log(JSON.stringify({ ok: true, data }));
if (args.includes("open")) {
  opened.push(args.at(-1));
  fs.writeFileSync(state, JSON.stringify(opened));
  emit({ page: "fixture" });
} else {
  const json = (payload) => ({ ok: true, json: async () => payload });
  emit(await vm.runInNewContext(args.at(-1), {
    URL, AbortSignal, setTimeout,
    location: { hostname: opened.length ? "www.bilibili.com" : "" },
    fetch: async (value) => {
      const url = new URL(value);
      if (url.pathname.endsWith("/nav")) return json({ code: 0, data: { isLogin: true, wbi_img: { img_url: "https://i/" + "a".repeat(32) + ".png", sub_url: "https://i/" + "b".repeat(32) + ".png" } } });
      if (url.pathname.endsWith("/view")) return json({ code: 0, data: { aid: 123 } });
      const next = Number(url.searchParams.get("next"));
      return json({ code: 0, data: { cursor: { next: next + 1, is_end: next === 1 }, replies: Array.from({ length: 30 }, (_, i) => ({ rpid_str: String(next * 30 + i + 1), content: { message: "评论" + (next * 30 + i) } })) } });
    }
  }));
}
