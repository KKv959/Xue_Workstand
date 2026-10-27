const pattern = /<!-- writer-preference:([a-f0-9-]+) -->\n[\s\S]*?\n<!-- \/writer-preference -->/g;

export function preferenceBlocks(style: string) {
  return [...style.matchAll(pattern)].map(match => ({ id: match[1], block: match[0] }));
}

export function writerStyleParts(style: string) {
  return {
    style: style.replace(pattern, "").trim(),
    preferences: preferenceBlocks(style).map(({ block }) => block
      .replace(/^<!--[^\n]+-->\n/, "")
      .replace(/^###[^\n]+\n/, "")
      .replace(/\n<!-- \/writer-preference -->$/, "").trim())
  };
}

export function addWriterPreference(style: string, id: string, text: string) {
  if (text.includes("<!--") || text.includes("-->")) throw new Error("写作偏好不能包含隐藏标记。");
  if (preferenceBlocks(style).length >= 20) throw new Error("已保存 20 条偏好，请先在风格卡中整理或删除旧偏好。");
  return `${style.trimEnd()}\n\n<!-- writer-preference:${id} -->\n### 用户明确保存的写作偏好（表达要求，不是博主原作证据）\n${text.trim()}\n<!-- /writer-preference -->`;
}

export function removeWriterPreference(style: string, id: string) {
  const entry = preferenceBlocks(style).find(item => item.id === id);
  if (!entry) throw Object.assign(new Error("这条偏好已被修改或撤销，请刷新风格卡。"), { statusCode: 409 });
  return style.replace(entry.block, "").trimEnd();
}

export function preserveWriterPreferences(generated: string, previous: string) {
  // Model output cannot promote itself into a user-confirmed preference.
  const clean = generated.replace(pattern, "").trimEnd();
  return [clean, ...preferenceBlocks(previous).map(item => item.block)].join("\n\n");
}
