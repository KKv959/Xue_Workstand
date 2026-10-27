"use client";

import { Sword } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const SKIN_STORAGE_KEY = "content-workbench-skin";
const SKIN_CHANGE_EVENT = "content-workbench-skin-change";
const SHINIGAMI_SKIN = "shinigami";
const DEFAULT_THEME_COLOR = "#f5f5f7";
const SHINIGAMI_THEME_COLOR = "#100d0e";

type SkinToggleProps = {
  compact?: boolean;
};

function isShinigamiSkinActive() {
  return document.documentElement.dataset.skin === SHINIGAMI_SKIN;
}

function readPersistedSkin() {
  try {
    return window.localStorage.getItem(SKIN_STORAGE_KEY) === SHINIGAMI_SKIN;
  } catch {
    // 本地偏好不可读时沿用当前页面已经应用的皮肤。
    return isShinigamiSkinActive();
  }
}

function updateThemeColor(active: boolean) {
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", active ? SHINIGAMI_THEME_COLOR : DEFAULT_THEME_COLOR);
}

function persistSkin(active: boolean) {
  try {
    if (active) {
      window.localStorage.setItem(SKIN_STORAGE_KEY, SHINIGAMI_SKIN);
    } else {
      window.localStorage.removeItem(SKIN_STORAGE_KEY);
    }
  } catch {
    // 浏览器禁用本地存储时仍允许本次换肤，只是不跨刷新保留。
  }
}

export function SkinToggle({ compact = false }: SkinToggleProps) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const syncSkin = () => {
      const nextActive = isShinigamiSkinActive();
      setActive(nextActive);
      updateThemeColor(nextActive);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SKIN_STORAGE_KEY) return;
      if (event.newValue === SHINIGAMI_SKIN) {
        document.documentElement.dataset.skin = SHINIGAMI_SKIN;
      } else {
        delete document.documentElement.dataset.skin;
      }
      syncSkin();
    };

    if (readPersistedSkin()) {
      document.documentElement.dataset.skin = SHINIGAMI_SKIN;
    }
    syncSkin();
    window.addEventListener(SKIN_CHANGE_EVENT, syncSkin);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(SKIN_CHANGE_EVENT, syncSkin);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const toggleSkin = useCallback(() => {
    const nextActive = !isShinigamiSkinActive();
    if (nextActive) {
      document.documentElement.dataset.skin = SHINIGAMI_SKIN;
    } else {
      delete document.documentElement.dataset.skin;
    }
    persistSkin(nextActive);
    setActive(nextActive);
    updateThemeColor(nextActive);
    window.dispatchEvent(new Event(SKIN_CHANGE_EVENT));
  }, []);

  const actionLabel = active ? "恢复原始皮肤" : "启用 BLEACH 死神皮肤";

  return (
    <button
      hidden
      style={{ display: "none" }}
      type="button"
      className={`skin-toggle ${compact ? "compact" : ""} ${active ? "active" : ""}`}
      aria-label={actionLabel}
      aria-pressed={active}
      onClick={toggleSkin}
      title={compact ? actionLabel : undefined}
    >
      <span className="skin-toggle-mark" aria-hidden="true">
        <Sword size={compact ? 19 : 18} strokeWidth={2} />
      </span>
      {compact ? null : (
        <>
          <span className="skin-toggle-copy">
            <strong>BLEACH·尸魂界</strong>
            <small>{active ? "黑崎一护 · 灵压展开" : "角色群像主题"}</small>
          </span>
          <span className="skin-toggle-state" aria-hidden="true">
            {active ? "还原" : "启用"}
          </span>
        </>
      )}
    </button>
  );
}
