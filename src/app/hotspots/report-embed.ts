// Presentation adapter only: the saved upstream report and its export logic stay intact.
const reportTheme = `
html, body { overflow: hidden !important; }
body, body.dark-mode { margin: 0; padding: 0; background: var(--bg) !important; color: var(--text) !important; font-family: var(--workbench-font) !important; }
body .container { width: 100%; max-width: none !important; margin: 0; border-radius: 0; box-shadow: none; background: transparent !important; overflow: visible; }
body .header { background: transparent !important; color: var(--text) !important; padding: 0 0 12px; text-align: left; }
.header-title, .header-info, .header-watermark, .toggle-wide-btn, .toggle-dark-btn, .reading-progress, .fab-container, .footer { display: none !important; }
body .save-buttons { position: relative; top: auto; right: auto; justify-content: flex-end; }
body .content { padding: 0 !important; }
body .save-btn, body .save-dropdown-trigger, body .tab-btn, body .tab-arrow { background: var(--panel-soft) !important; color: var(--text) !important; border-color: var(--line) !important; }
body .save-dropdown-menu, body .save-dropdown-item, body .search-input { background: var(--panel) !important; color: var(--text) !important; border-color: var(--line) !important; }
body .tab-btn.active { background: var(--text-strong) !important; color: var(--panel) !important; }
body .tab-bar-wrapper { position: static; background: transparent !important; border-color: var(--line); }
body .tab-scroll-indicator { background: var(--accent) !important; }
body .word-header, body .feed-header, body .standalone-header, body .news-item { border-color: var(--line) !important; }
body .word-name, body .news-title, body .news-title a, body .rss-title, body .rss-title a, body .feed-name, body .ai-section-title, body .ai-block-title, body .ai-block-content { color: var(--text) !important; }
body .word-count, body .news-source, body .news-time, body .rss-time { color: var(--muted) !important; }
body .ai-section { background: transparent !important; border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 24px 0 0; }
body .ai-block { background: transparent !important; box-shadow: none; padding: 16px 0; border-bottom: 1px solid var(--line); border-radius: 0; }
body .ai-section-badge { background: var(--panel-soft); color: var(--muted); }
body .news-item:hover { background: var(--panel-soft) !important; }
body[data-reading-view="analysis"] .content > :not(.ai-section) { display: none !important; }
body[data-reading-view="sources"] .ai-section { display: none !important; }
body .container { max-width: 960px !important; margin-inline: auto; }
body .header { padding: 0 0 16px !important; }
body .ai-section { margin-top: 0; padding-top: 0; border-top: 0; }
body .ai-section-header { display: none; }
body.wide-mode .ai-section .ai-blocks-grid { display: block; }
body .ai-block { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 28px; margin: 0; padding: 28px 0; }
body .ai-block:first-child { padding-top: 4px; }
body .ai-block-title { font-size: 16px; line-height: 1.7; margin: 0; }
body .ai-block-content { font-size: 15px; line-height: 1.9; overflow-wrap: anywhere; }
body .news-item { padding-block: 16px; }
body .news-title { font-size: 15px; line-height: 1.7; }
body .rank-num, body .count-info, body .news-number { background: var(--panel-soft) !important; color: var(--muted) !important; }
body .trend-up, body .trend-down { display: none; }
body .search-bar { margin: 0 0 20px; }
@media (max-width: 700px) { body .ai-block { grid-template-columns: 1fr; gap: 12px; padding-block: 24px; } }
body :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
`;

export function integrateReport(frame: HTMLIFrameElement): () => void {
  const doc = frame.contentDocument;
  const container = doc?.querySelector<HTMLElement>(".container");
  const viewport = frame.parentElement;
  if (!doc || !container || !viewport) throw new Error("报告页面未能载入，请重新读取报告");
  const style = doc.createElement("style");
  style.textContent = reportTheme;
  doc.head.appendChild(style);
  doc.body.classList.remove("dark-mode");
  doc.body.classList.add("wide-mode");
  const sync = () => {
    const theme = getComputedStyle(viewport);
    for (const token of ["--bg", "--panel", "--panel-soft", "--text", "--text-strong", "--muted", "--line", "--accent"]) {
      doc.documentElement.style.setProperty(token, theme.getPropertyValue(token));
    }
    doc.documentElement.style.setProperty("--workbench-font", theme.fontFamily);
    // The frame's inverse zoom and transform already compensate for app scaling.
    viewport.style.height = `${Math.ceil(container.getBoundingClientRect().height) + 4}px`;
  };
  const observer = new ResizeObserver(sync);
  observer.observe(container);
  observer.observe(viewport);
  const themeObserver = new MutationObserver(sync);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  sync();
  return () => { observer.disconnect(); themeObserver.disconnect(); style.remove(); };
}
