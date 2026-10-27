import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// 直接测试共享组件；页面和浏览器均隔离，不接业务 API 或正式资料库。
const root = process.cwd();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-overlays-'));
let server, browser;
try {
  await fs.symlink(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
  await fs.writeFile(path.join(temporary, 'index.html'), '<div id="root"></div><script type="module" src="/main.jsx"></script>');
  await fs.writeFile(path.join(temporary, 'main.jsx'), `
import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModalBackdrop} from '@/components/ModalBackdrop';
import {ConfirmDialog} from '@/components/ConfirmDialog';
import {WorkbenchSelect} from '@/components/WorkbenchSelect';
import '@/app/globals.css';
import '@/components/workbench-select.css';
function Check() {
  const [open, setOpen] = useState(false), [nested, setNested] = useState(false);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [count, setCount] = useState(0);
  const input = useRef(null);
  return <><button onClick={() => setOpen(true)}>打开测试弹窗</button><output>确认次数 {count}</output>
    {open && <ModalBackdrop aria-label="测试弹窗" className="modal-panel" initialFocusRef={input} disabled={busy}
      onClose={() => { if (!dirty || window.confirm('放弃未保存修改？')) {setOpen(false); setDirty(false);} }}>
      <input ref={input} aria-label="输入内容" />
      <WorkbenchSelect aria-label="测试选项" value="a" onValueChange={() => {}}><option value="a">甲</option><option value="b">乙</option></WorkbenchSelect>
      <button onClick={() => setNested(true)}>打开确认</button>
      <button onClick={() => setBusy(!busy)}>{busy ? '解除锁定' : '锁定关闭'}</button>
      <button onClick={() => setDirty(true)}>标记未保存</button>
    </ModalBackdrop>}
    {nested && <ConfirmDialog title="确认测试" body="只验证交互" onCancel={() => setNested(false)} onConfirm={() => {setCount(count + 1); setNested(false);}} />}
  </>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Check /></React.StrictMode>);
`);
  server = await createServer({ configFile: false, root: temporary, plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'src') }, dedupe: ['react', 'react-dom'] },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react-aria-components', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root, temporary] } } });
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  const outer = page.getByRole('dialog', { name: '测试弹窗', exact: true });
  const open = page.getByRole('button', { name: '打开测试弹窗' });
  const focused = locator => locator.evaluate(element => element === document.activeElement);
  await open.click();
  assert.equal(await focused(page.getByRole('textbox', { name: '输入内容' })), true, '初始焦点');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await outer.evaluate(element => element.contains(document.activeElement)), true, 'Tab 焦点约束');
  }
  await page.getByRole('button', { name: '测试选项' }).click();
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await outer.isVisible(), true, '浮层 Escape 不应关闭父弹窗');
  await page.getByRole('button', { name: '锁定关闭' }).click();
  await page.keyboard.press('Escape');
  await page.mouse.click(2, 2);
  assert.equal(await outer.isVisible(), true, '忙碌状态不能关闭');
  await page.getByRole('button', { name: '解除锁定' }).click();
  await page.getByRole('button', { name: '打开确认' }).click();
  const nested = page.getByRole('dialog', { name: '确认测试' });
  await nested.waitFor();
  assert.equal(await focused(nested.getByRole('button', { name: '确认', exact: true })), true, '确认按钮初始焦点');
  await page.keyboard.press('Escape');
  await nested.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.textContent === '打开确认');
  assert.equal(await focused(page.getByRole('button', { name: '打开确认' })), true, '嵌套焦点恢复');
  await page.getByRole('button', { name: '打开确认' }).click();
  await page.keyboard.press('Enter');
  await nested.waitFor({ state: 'detached' });
  assert.equal(await page.locator('output').textContent(), '确认次数 1', 'Enter 仅提交一次');
  await page.getByRole('button', { name: '标记未保存' }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Escape');
  assert.equal(await outer.isVisible(), true, '拒绝放弃后保留内容');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await outer.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.textContent === '打开测试弹窗');
  assert.equal(await focused(open), true, '关闭后恢复触发器焦点');
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await open.click();
    const rect = await outer.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1, '弹窗位于视口内');
    await page.mouse.click(2, 2);
    await outer.waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, [], '浏览器运行错误');
  console.log('弹窗检查通过：焦点、嵌套浮层、忙碌禁用、未保存确认、Enter、桌面与手机布局。');
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
