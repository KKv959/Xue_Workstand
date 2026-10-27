import { NextResponse } from "next/server";
import { z } from "zod";

type ApiResponseOptions = {
  fallbackMessage: string;
  status?: number;
  formatError?: (error: unknown, fallbackMessage: string) => string;
};

class ApiRouteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRouteError";
  }
}

export async function apiJson<T>(
  run: () => Promise<T> | T,
  options: ApiResponseOptions
) {
  try {
    return NextResponse.json(await run());
  } catch (error) {
    return apiError(error, options);
  }
}

export function apiError(error: unknown, options: ApiResponseOptions) {
  return NextResponse.json(
    { error: options.formatError?.(error, options.fallbackMessage) ?? formatApiError(error, options.fallbackMessage) },
    { status: getApiErrorStatus(error, options) }
  );
}

export async function parseJsonBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema
): Promise<z.infer<TSchema>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiRouteError("请求 JSON 格式不正确。", 400);
  }
  return schema.parse(body);
}

export function formatApiError(error: unknown, fallbackMessage: string) {
  if (error instanceof z.ZodError) {
    return formatZodError(error) || fallbackMessage;
  }
  return error instanceof Error && error.message.trim() ? error.message : fallbackMessage;
}

function formatZodError(error: z.ZodError) {
  const issues = flattenZodIssues(error.issues);
  const issue = issues.find(hasCustomZodMessage) || issues.find((candidate) => candidate.path.length > 0) || issues[0];
  if (!issue) return "";

  const path = issue.path.join(".");
  if (issue.code === "invalid_string" && issue.validation === "url") {
    return "链接格式不正确，请粘贴完整的 http(s) 地址。";
  }
  if (path.endsWith("url") || path.endsWith("mediaUrl") || path.endsWith("videoUrl")) {
    return "链接格式不正确，请粘贴完整的 http(s) 地址。";
  }
  if (issue.code === "invalid_type") {
    if (hasCustomZodMessage(issue)) {
      return issue.message;
    }
    return "请求参数不完整或格式不正确。";
  }
  if (hasCustomZodMessage(issue)) {
    return issue.message;
  }
  return "请求参数不完整或格式不正确。";
}

function flattenZodIssues(issues: z.ZodIssue[]): z.ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "invalid_union") return [issue];
    return flattenZodIssues(issue.unionErrors.flatMap((unionError) => unionError.issues));
  });
}

function hasCustomZodMessage(issue: z.ZodIssue) {
  return Boolean(issue.message && !/^(Invalid|Required|Expected)\b/i.test(issue.message));
}

function getApiErrorStatus(error: unknown, options: ApiResponseOptions) {
  if (error instanceof z.ZodError) return 400;
  if (error instanceof ApiRouteError) return error.status;
  const status = getErrorStatus(error);
  if (status) return status;
  return options.status ?? 500;
}

function getErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") return 0;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : candidate.status;
  if (typeof status !== "number" || !Number.isInteger(status)) return 0;
  return status >= 400 && status <= 599 ? status : 0;
}

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

// 公网入口没有登录：写入模型授权或系统配置的接口只接受本机同源页面发起的请求。
export function isLocalSameOriginRequest(request: Request) {
  const url = new URL(request.url);
  const host = new URL(`http://${request.headers.get("host") || url.host}`);
  return request.headers.get("origin") === host.origin &&
    LOCAL_HOSTNAMES.includes(host.hostname) &&
    LOCAL_HOSTNAMES.includes(url.hostname);
}
