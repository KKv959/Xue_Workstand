export async function copyText(text: string) {
  // 在点击事件内同步复制，兼容首次异步剪贴板调用丢失用户激活的浏览器。
  const previousFocus = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(field);
  let copied = false;
  try {
    field.select();
    copied = document.execCommand("copy");
  } catch {
    // 旧复制接口不可用时继续尝试标准剪贴板接口。
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
  if (!copied) await navigator.clipboard.writeText(text);
}
