"use client";

import { useCallback, useEffect, useState } from "react";
import { getAiModelSettings, saveAiModelSettings } from "@/lib/client";
import { AI_POLICIES, type AiPolicyId, type AiPolicyOverrides, type AiPolicyValue, type AiSettingsView } from "@/lib/ai-policy-catalog";

export function useAiSettings() {
  const [saved, setSaved] = useState<AiSettingsView | null>(null);
  const [overrides, setOverrides] = useState<AiPolicyOverrides>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [itemErrors, setItemErrors] = useState<Partial<Record<AiPolicyId, string>>>({});
  const [message, setMessage] = useState("");
  const dirtyIds = AI_POLICIES.filter(p => !("retired" in p && p.retired) && JSON.stringify(overrides[p.id]) !== JSON.stringify(saved?.overrides[p.id])).map(p => p.id);
  const dirty = dirtyIds.length > 0;
  const load = useCallback(async () => {
    setLoading(true); setError(""); setItemErrors({});
    try { const data = await getAiModelSettings(); setSaved(data); setOverrides(data.overrides); setMessage(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取配置失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  function change(ids: AiPolicyId[], patch: Partial<AiPolicyValue> | null) {
    if (!saved) return;
    setMessage(""); setItemErrors(current => { const next = { ...current }; ids.forEach(id => delete next[id]); return next; });
    setOverrides(current => {
      const next = { ...current };
      for (const id of ids) {
        if (!patch) { delete next[id]; continue; }
        const value = { ...(next[id] || saved.defaults[id]), ...patch };
        if (JSON.stringify(value) === JSON.stringify(saved.defaults[id])) delete next[id];
        else next[id] = value;
      }
      return next;
    });
  }
  async function save(id: AiPolicyId) {
    if (!saved || saving) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const nextOverrides = { ...saved.overrides };
      if (overrides[id]) nextOverrides[id] = overrides[id]; else delete nextOverrides[id];
      const data = await saveAiModelSettings({ schemaVersion: 1, revision: saved.revision, updatedAt: saved.updatedAt, overrides: nextOverrides });
      setSaved(data);
      setMessage("已应用");
    } catch (cause) {
      setItemErrors(current => ({ ...current, [id]: cause instanceof Error ? cause.message : "保存配置失败" }));
    }
    finally { setSaving(false); }
  }
  return { saved, overrides, loading, saving, error, itemErrors, message, dirty, dirtyIds, load, change, save,
    discard: () => { if (saved) setOverrides(saved.overrides); setMessage(""); } };
}
