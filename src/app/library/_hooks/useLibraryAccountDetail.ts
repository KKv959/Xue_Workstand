"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cachedGetAccountDetail } from "@/lib/detail-cache";
import type { AccountDetail, AccountListItem } from "@/lib/types";

type ReloadOptions = {
  includeStyle?: boolean;
  force?: boolean;
};

type UseLibraryAccountDetailInput = {
  selectedAccountMeta: AccountListItem | null;
};

export function useLibraryAccountDetail({ selectedAccountMeta }: UseLibraryAccountDetailInput) {
  const [accountDetail, setAccountDetail] = useState<AccountDetail | null>(null);
  const [accountDetailLoading, setAccountDetailLoading] = useState(false);
  const [accountDetailError, setAccountDetailError] = useState("");

  const selectedAccountDetailId = selectedAccountMeta?.id || "";
  const selectedAccountDetailPlatform = selectedAccountMeta?.platform;
  const selectedAccountUpdatedAt = selectedAccountMeta?.updatedAt || "";
  const requestSeqRef = useRef(0);

  const reloadSelectedAccountDetail = useCallback(async (options: ReloadOptions = {}) => {
    if (!selectedAccountDetailId || !selectedAccountDetailPlatform) return null;
    const requestSeq = ++requestSeqRef.current;
    const accountId = selectedAccountDetailId;
    const platform = selectedAccountDetailPlatform;
    const detail = await cachedGetAccountDetail({
      platform,
      accountId,
      includeStyle: options.includeStyle ?? true,
      version: selectedAccountUpdatedAt,
      force: options.force ?? true
    });
    if (requestSeq !== requestSeqRef.current) return null;
    setAccountDetail((current) => {
      if (!current || current.id !== detail.id || typeof detail.style === "string") return detail;
      if (typeof current.style === "string") return { ...detail, style: current.style };
      return detail;
    });
    setAccountDetailLoading(false);
    return detail;
  }, [selectedAccountDetailId, selectedAccountDetailPlatform, selectedAccountUpdatedAt]);

  useEffect(() => {
    let ignore = false;
    const requestSeq = ++requestSeqRef.current;
    if (!selectedAccountDetailId || !selectedAccountDetailPlatform) {
      setAccountDetail(null);
      setAccountDetailError("");
      setAccountDetailLoading(false);
      return;
    }

    setAccountDetailLoading(true);
    setAccountDetailError("");
    cachedGetAccountDetail({
      platform: selectedAccountDetailPlatform,
      accountId: selectedAccountDetailId,
      includeStyle: true,
      version: selectedAccountUpdatedAt
    })
      .then((detail) => {
        if (ignore || requestSeq !== requestSeqRef.current) return;
        setAccountDetail(detail);
      })
      .catch((err) => {
        if (ignore || requestSeq !== requestSeqRef.current) return;
        setAccountDetail(null);
        setAccountDetailError(err instanceof Error ? err.message : "读取账号详情失败");
      })
      .finally(() => {
        if (!ignore && requestSeq === requestSeqRef.current) setAccountDetailLoading(false);
      });

    return () => {
      ignore = true;
      if (requestSeq === requestSeqRef.current) requestSeqRef.current += 1;
    };
  }, [selectedAccountDetailId, selectedAccountDetailPlatform, selectedAccountUpdatedAt]);

  return {
    accountDetail,
    accountDetailError,
    accountDetailLoading,
    reloadSelectedAccountDetail,
    selectedAccountDetailId,
    selectedAccountDetailPlatform,
    setAccountDetail
  };
}
