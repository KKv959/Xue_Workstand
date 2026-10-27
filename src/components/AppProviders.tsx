"use client";

import { usePathname } from "next/navigation";
import { LibraryProvider } from "./LibraryProvider";
import { TaskProvider } from "./TaskProvider";
import { FeedbackProvider } from "./FeedbackProvider";
import { RemoteStatusProvider } from "./RemoteStatusProvider";
import type { AppMode } from "@/lib/app-mode";

export function AppProviders({
  appMode,
  buildId,
  children
}: {
  appMode: AppMode;
  buildId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const needsLibrary = appMode !== "gross-margin" && isLibraryRoute(pathname);

  return (
    <RemoteStatusProvider currentBuildId={buildId}>
      <FeedbackProvider>
        <LibraryProvider enabled={needsLibrary}>
          <TaskProvider allowedKinds={appMode === "gross-margin" ? ["gross-margin-refresh"] : undefined}>
            {children}
          </TaskProvider>
        </LibraryProvider>
      </FeedbackProvider>
    </RemoteStatusProvider>
  );
}

function isLibraryRoute(pathname: string) {
  return pathname.startsWith("/mobile") || pathname === "/library" || pathname === "/writer";
}
