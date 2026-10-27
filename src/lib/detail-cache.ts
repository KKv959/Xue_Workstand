"use client";

import { getAccountDetail } from "@/lib/client";
import type { AccountDetail, Platform } from "@/lib/types";

type DetailCacheOptions = {
  includeStyle?: boolean;
  version?: string;
  force?: boolean;
};

const accountDetailCache = new Map<string, AccountDetail>();
const accountDetailRequests = new Map<string, Promise<AccountDetail>>();
const MAX_CACHE_ENTRIES = 60;

export function cachedGetAccountDetail(input: {
  platform: Platform;
  accountId: string;
} & DetailCacheOptions) {
  const cacheKey = accountDetailCacheKey(input.platform, input.accountId, input);
  if (input.force) invalidateAccountDetail(input.platform, input.accountId);

  const cached = accountDetailCache.get(cacheKey);
  if (cached && !input.force) return Promise.resolve(cached);

  const pending = accountDetailRequests.get(cacheKey);
  if (pending && !input.force) return pending;

  const request = getAccountDetail({
    platform: input.platform,
    accountId: input.accountId,
    includeStyle: input.includeStyle
    })
    .then((detail) => {
      if (accountDetailRequests.get(cacheKey) === request) remember(accountDetailCache, cacheKey, detail);
      return detail;
    })
    .finally(() => {
      if (accountDetailRequests.get(cacheKey) === request) accountDetailRequests.delete(cacheKey);
    });

  accountDetailRequests.set(cacheKey, request);
  return request;
}

export function getCachedAccountDetail(input: {
  platform: Platform;
  accountId: string;
} & DetailCacheOptions) {
  return accountDetailCache.get(accountDetailCacheKey(input.platform, input.accountId, input)) || null;
}

export function invalidateAccountDetail(platform?: Platform, accountId?: string) {
  const prefix = platform && accountId ? accountDetailPrefix(platform, accountId) : "account|";
  deleteMatching(accountDetailCache, prefix);
  deleteMatching(accountDetailRequests, prefix);
}

function accountDetailPrefix(platform: Platform, accountId: string) {
  return `account|${platform}|${accountId}|`;
}

function accountDetailCacheKey(platform: Platform, accountId: string, options: DetailCacheOptions) {
  return `${accountDetailPrefix(platform, accountId)}${options.includeStyle ? "style" : "base"}|${options.version || "current"}`;
}

function remember<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function deleteMatching<T>(map: Map<string, T>, prefix: string) {
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key);
  }
}
