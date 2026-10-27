export const DOUYIN_SESSION_ERROR = "抖音网页会话尚未就绪（Uifid 缺失），请在 Chrome 打开抖音并完成页面验证后重试。";
export const DOUYIN_ACCESS_ERROR = "抖音拒绝访问（403/444），请在 Chrome 打开抖音检查登录或验证状态，稍后再刷新。";
export const DOUYIN_RATE_LIMIT_ERROR = "抖音请求过于频繁（429），请稍后再刷新。";
export const DOUYIN_LOGIN_ERROR = "抖音登录或安全验证未通过，请在 Chrome 打开抖音完成登录或验证后重试。";

/** 同时识别历史任务中的原始错误和新任务中的中文错误。 */
export function getDouyinAccessError(message: string): string | null {
  if (!/douyin|抖音|ArgusSecurityPlugin|Uifid|aweme\/post/i.test(message)) return null;
  if (/Uifid|抖音网页会话尚未就绪/i.test(message)) return DOUYIN_SESSION_ERROR;
  if (/抖音请求过于频繁|aweme\/post(?: HTTP)? 429/i.test(message)) return DOUYIN_RATE_LIMIT_ERROR;
  if (/ArgusSecurityPlugin|抖音拒绝访问|Access Denied|<!DOCTYPE|JSON parse failed.*(?:html|denied)|Douyin API error [34]\b|aweme\/post(?: HTTP)? (?:403|444)/i.test(message)) return DOUYIN_ACCESS_ERROR;
  if (/抖音登录或安全验证未通过|aweme\/post(?: HTTP)? 401/i.test(message)) return DOUYIN_LOGIN_ERROR;
  return null;
}

export function pausedDouyinRefreshError(reason: string) {
  return `本轮剩余抖音请求已暂停，该账号未完成采集；${reason}`;
}
