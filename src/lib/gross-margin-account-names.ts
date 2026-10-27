import type { GrossMarginAccountPrice } from "./types";

// 名称只在匹配和界面显示时归一化；远端原名、账号 ID、项目 ID 与历史记录不改写。
// “丶”属于汉字类别，需单独处理；保留字母、数字和 + 等有意义的符号。
export function getGrossMarginAccountDisplayName(value: string) {
  return value.normalize("NFKC").replace(/[\p{P}丶]/gu, "").replace(/\s+/g, " ").trim();
}

export function normalizeGrossMarginAccountName(value: string) {
  return getGrossMarginAccountDisplayName(value).replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

export function getGrossMarginAccountNameOptions(names: string[]) {
  const byName = new Map<string, string>();
  for (const name of names) {
    const value = normalizeGrossMarginAccountName(name);
    if (value && !byName.has(value)) byName.set(value, getGrossMarginAccountDisplayName(name));
  }
  return [...byName].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

export function getGrossMarginAccountOptions(accounts: GrossMarginAccountPrice[]) {
  const byName = new Map<string, GrossMarginAccountPrice>();
  for (const account of accounts) {
    const name = getGrossMarginAccountDisplayName(account.name);
    const normalized = normalizeGrossMarginAccountName(name);
    if (!normalized) continue;
    const key = `${account.platform}:${normalized}`;
    // 若两种写法同时出现，优先使用源表中本就不带标点的规范写法。
    if (!byName.has(key) || account.name.trim() === name) byName.set(key, { ...account, name });
  }
  return [...byName.values()];
}
