import { apiError } from "@/lib/api-route";
import { getTrendRadarNativeHtml } from "@/lib/trendradar-native";

export const runtime = "nodejs";
export async function GET() {
  try {
    return new Response(await getTrendRadarNativeHtml(), { headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "sandbox allow-scripts allow-same-origin allow-popups allow-downloads; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js; style-src 'unsafe-inline'; img-src data: https:; font-src data:; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
    } });
  } catch (error) { return apiError(error, { fallbackMessage: "读取 TrendRadar 原生报告失败" }); }
}
