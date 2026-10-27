"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import type { DouyinHotlistItem, Platform } from "@/lib/types";
import { getAccountInitial, getPlatformLabel } from "../_lib/douyin-hotlist-model";

const platformLogoSrc: Record<Platform, string> = {
  bilibili: "/platform-logos/bilibili.png",
  douyin: "/platform-logos/douyin.png"
};

export function AccountAvatarImage({
  account,
  size
}: {
  account: Pick<DouyinHotlistItem["account"], "avatarUrl" | "id" | "name">;
  size: number;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [account.avatarUrl]);

  if (!account.avatarUrl || failed) return <>{getAccountInitial(account.name)}</>;

  return (
    <Image
      alt=""
      height={size}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={account.avatarUrl}
      unoptimized
      width={size}
    />
  );
}

export function PlatformLogoBadge({ platform }: { platform: Platform }) {
  const label = getPlatformLabel(platform);

  return (
    <span
      aria-label={label}
      className={`douyin-hotlist-platform-logo platform-${platform}`}
      role="img"
      title={label}
    >
      <Image
        alt=""
        aria-hidden="true"
        className="douyin-hotlist-platform-logo-image"
        height={18}
        src={platformLogoSrc[platform]}
        unoptimized
        width={18}
      />
    </span>
  );
}
