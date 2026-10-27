import { NextResponse, type NextRequest } from "next/server";

const grossMarginAllowedPrefixes = [
  "/api/health",
  "/gross-margin",
  "/api/gross-margin",
  "/api/jobs",
  "/api/remote/status",
  "/_next",
  "/favicon.ico"
];

export function middleware(request: NextRequest) {
  if (process.env.APP_MODE !== "gross-margin") {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (isAllowedGrossMarginPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "当前运行模式只开放数据维护接口。" }, { status: 403 });
  }

  const target = request.nextUrl.clone();
  target.pathname = "/gross-margin";
  target.search = "";
  return NextResponse.redirect(target);
}

function isAllowedGrossMarginPath(pathname: string) {
  if (!pathname) return false;
  if (pathname === "/") return false;
  if (grossMarginAllowedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return true;
  }
  if (pathname.startsWith("/api/")) return false;
  if (/\.[a-z0-9]+$/i.test(pathname)) {
    return true;
  }
  return false;
}

export const config = {
  matcher: ["/:path*"]
};
