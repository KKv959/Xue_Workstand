"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { AppMode } from "@/lib/app-mode";

const allowedGrossMarginPrefixes = ["/gross-margin"];

export function AppModeGuard({ appMode }: { appMode: AppMode }) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (appMode !== "gross-margin") return;
    if (!pathname) return;
    if (allowedGrossMarginPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return;
    router.replace("/gross-margin");
  }, [appMode, pathname, router]);

  return null;
}
