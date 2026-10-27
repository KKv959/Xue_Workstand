import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Execute the components' actual positioning callbacks without a browser or user data.
function callback(file: string, start: string, end: string, context: Record<string, unknown>) {
  const source = readFileSync(file, "utf8");
  assert.ok(source.includes(start) && source.includes(end));
  return vm.runInNewContext(`(() => {${source.split(start)[1].split(end)[0]}})()`, context);
}

test("浮层坐标在 90%/100% 缩放下对齐锚点，并在视口边缘换侧", () => {
  for (const zoom of [0.9, 1]) {
    const environment = { window: { innerWidth: 1280, innerHeight: 720 }, document: { documentElement: {} }, getComputedStyle: () => ({ zoom: String(zoom) }) };
    let drawer: Record<string, string> = {};
    callback("src/components/TaskCenter.tsx", "const updateDrawerPosition = useCallback(() => {", "}, [variant]);", {
      ...environment, variant: "sidebar", triggerRef: { current: { getBoundingClientRect: () => ({ right: 190, bottom: 657 }) } },
      setDrawerPosition: (value: Record<string, string>) => { drawer = value; }
    });
    assert.ok(Math.abs(parseFloat(drawer["--task-drawer-left"]) * zoom - (190 + 12 * zoom)) < 1);
    assert.ok(Math.abs(parseFloat(drawer["--task-drawer-bottom"]) * zoom - 63) < 1);

    const contextStyle = callback("src/app/assets/_components/EngagementHistoryPane.tsx", "const contextMenuStyle = useMemo(() => {", "}, [contextMenu]);", {
      ...environment, contextMenu: { x: 741, y: 444 }
    });
    assert.equal(contextStyle.left * zoom, 741);
    assert.equal(contextStyle.top * zoom, 444);

    for (const [top, bottom, placement, expected] of [[20, 50, "above", "below"], [650, 680, "below", "above"]] as const) {
      const surface = { style: {} as Record<string, string>, dataset: {} as Record<string, string>, offsetWidth: 280,
        get offsetHeight() { return Math.min(300, parseFloat(this.style.maxHeight)); } };
      callback("src/app/images/_components/ImageControlPopover.tsx", "const position = useCallback(() => {", "}, [width, placement]);", {
        ...environment, button: { current: { getBoundingClientRect: () => ({ top, bottom, left: 1200, width: 40 }) } },
        panel: { current: surface }, width: 280, placement
      });
      assert.equal(surface.dataset.placement, expected);
      assert.ok(parseFloat(surface.style.left) * zoom + surface.offsetWidth * zoom <= 1280 - 12 * zoom);
      assert.ok(parseFloat(surface.style.top) * zoom >= 12 * zoom);
      assert.ok((parseFloat(surface.style.top) + surface.offsetHeight) * zoom <= 720 - 12 * zoom);
    }
  }
});
