// Stable asset IDs survive renaming and reordering; labels are only presentation.
export function imageMentionToken(id: string, label: string) {
  return `@[${label.replace(/[\[\]\r\n]/g, " ").slice(0, 160)}](image:${id})`;
}
export function imageMentionPattern() {
  return /@\[([^\]\r\n]*)\]\(image:([a-f0-9-]{36})\)/gi;
}
export function imagePromptLabel(prompt: string) {
  return prompt.replace(imageMentionPattern(), (_token, label: string) => `@${label}`);
}
export function resolveImageMentions(prompt: string, referenceIds: string[]) {
  if (new Set(referenceIds).size !== referenceIds.length) throw new Error("参考图重复，请移除重复图片。");
  const resolved = prompt.replace(imageMentionPattern(), (_token, label: string, id: string) => {
    const index = referenceIds.indexOf(id);
    if (index < 0) throw new Error(`引用的图片「${label}」已不在参考图中，请重新添加或删除该引用。`);
    return `参考图 ${index + 1}（${label}）`;
  });
  return resolved;
}

export function removeImageMention(prompt: string, referenceId: string) {
  return prompt.replace(imageMentionPattern(), (token, _label: string, id: string) => id === referenceId ? "" : token);
}
export function appendImageMention(prompt: string, id: string, label: string) {
  if (Array.from(prompt.matchAll(imageMentionPattern())).some((match) => match[2] === id)) return prompt;
  return `${prompt}${prompt && !/\s$/.test(prompt) ? " " : ""}${imageMentionToken(id, label)} `;
}
