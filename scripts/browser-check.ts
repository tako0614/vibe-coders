// Uses an existing Chrome debugging endpoint; creates and closes an isolated context.
// Start test/fixtures/preview.ts and Vite before running this check.
import { mkdirSync } from 'node:fs';
const endpoint = process.env.VIBE_CODER_CDP || 'http://127.0.0.1:9222';
const version = (await (await fetch(`${endpoint}/json/version`)).json()) as {
  webSocketDebuggerUrl: string;
};
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = reject;
});
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
ws.onmessage = (event) => {
  const data = JSON.parse(String(event.data));
  const call = pending.get(data.id);
  if (!call) return;
  pending.delete(data.id);
  data.error ? call.reject(new Error(JSON.stringify(data.error))) : call.resolve(data.result);
};
const command = (method: string, params: object = {}, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timed out: ${method}`));
    }, 15000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const { browserContextId } = await command('Target.createBrowserContext');
const { targetId } = await command('Target.createTarget', { url: 'about:blank', browserContextId });
const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
const evaluate = async (expression: string) => {
  const result = await command(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const until = async (expression: string, timeout = 10000) => {
  const start = Date.now();
  while (!(await evaluate(expression))) {
    if (Date.now() - start > timeout) throw new Error(`Browser check timed out: ${expression}`);
    await Bun.sleep(50);
  }
};
const clickText = async (text: string) => {
  await until(
    `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes(${JSON.stringify(text)}))`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(text)})).click()`,
  );
};
const setValue = async (selector: string, value: string) => {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`);
  return evaluate(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)}); const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
};
const screenshot = async (name: string) => {
  const result = await command(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    sessionId,
  );
  await Bun.write(`/tmp/vibe-coder-browser/${name}.png`, Buffer.from(result.data, 'base64'));
};
const errors: string[] = [];
await command('Runtime.enable', {}, sessionId);
await command('Page.enable', {}, sessionId);
const old = ws.onmessage!;
ws.onmessage = (event) => {
  const data = JSON.parse(String(event.data));
  if (data.sessionId === sessionId && data.method === 'Runtime.exceptionThrown')
    errors.push(data.params.exceptionDetails.text);
  old.call(ws, event);
};
mkdirSync('/tmp/vibe-coder-browser', { recursive: true });
try {
  const navigation = await command('Page.navigate', { url: 'http://127.0.0.1:5173' }, sessionId);
  if (navigation.errorText) throw new Error(navigation.errorText);
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await until(`!!document.querySelector('input[name="username"]')`);
  await setValue('input[name="username"]', 'owner');
  await setValue('input[name="password"]', 'test-only-password-123');
  await evaluate(`document.querySelector('form').requestSubmit()`);
  await until(`document.body.textContent.includes('今日、何を進めますか。')`);
  await screenshot('desktop');
  const previousChats = await evaluate(
    `document.querySelectorAll('.conversation-list button').length`,
  );
  await clickText('新しい会話');
  await until(`document.querySelectorAll('.conversation-list button').length > ${previousChats}`);
  await clickText('ターミナル');
  if (process.env.VIBE_CODER_TEST_AUTH === '1') {
    const authState = process.env.VIBE_CODER_TEST_AUTH_STATE;
    if (!authState)
      throw new Error('Use the same isolated fixture auth-state path as the preview.');
    await setValue('textarea[name="prompt"]', 'auth-ui-original');
    await evaluate(`document.querySelector('form.form-card').requestSubmit()`);
    await clickText('入力依頼');
    await until(
      `document.querySelector('.codex-login-details')?.textContent.includes('PRIVATE-CODE-234')`,
    );
    await screenshot('codex-login');
    await Bun.write(authState, JSON.stringify({ signedIn: true, finish: true }));
    await until(
      `document.querySelector('.request-result')?.textContent.includes('認証の完了を確認しました')`,
    );
    if (await evaluate(`document.body.textContent.includes('PRIVATE-CODE-234')`))
      throw new Error('Completed login code remained visible.');
    await clickText('ターミナル');
    await until(
      `document.querySelector('.terminal-footer')?.textContent.includes('completed') && document.querySelector('.run-output')?.textContent.includes('resumed after login')`,
    );
  }
  if (process.env.VIBE_CODER_TEST_NATIVE === '1') {
    await setValue('textarea[name="prompt"]', 'hello');
    await evaluate(`document.querySelector('form.form-card').requestSubmit()`);
    await until(
      `document.querySelector('.terminal-footer')?.textContent.includes('completed') && document.querySelector('.run-output')?.textContent.includes('native response')`,
    );
    if (await evaluate(`!!document.querySelector('.xterm')`))
      throw new Error('Native run has a fabricated PTY.');
    await until(`document.querySelector('.run-details')?.textContent.includes('native-thread')`);
    await setValue('.run-details textarea[name="prompt"]', 'follow-up');
    await evaluate(`document.querySelector('.run-details form').requestSubmit()`);
    await until(
      `document.querySelectorAll('.session-list button').length === 2 && document.querySelector('.terminal-footer')?.textContent.includes('completed')`,
    );
    await screenshot('native');
  }
  await clickText('ターミナルを開く');
  await until(`!!document.querySelector('.terminal-surface .xterm-helper-textarea')`);
  await clickText('手動で操作する');
  await until(`document.body.textContent.includes('あなたが操作中')`);
  await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  await command('Input.insertText', { text: 'printf "browser-terminal-ok\\n"' }, sessionId);
  await command(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    sessionId,
  );
  await command(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    sessionId,
  );
  await Bun.sleep(700);
  await screenshot('terminal');
  await clickText('予定');
  await clickText('予定を追加');
  await setValue('input[name="title"]', 'ブラウザから登録した予定');
  await setValue('textarea[name="prompt"]', '進捗を確認して。');
  await evaluate(`document.querySelector('.form-card').requestSubmit()`);
  await until(
    `!!document.querySelector('.list-card') && document.body.textContent.includes('ブラウザから登録した予定')`,
  );
  await clickText('記憶');
  await clickText('記憶を追加');
  await setValue('textarea[name="text"]', 'ブラウザで保存した検証用の記憶。');
  await evaluate(`document.querySelector('.form-card').requestSubmit()`);
  await until(`!!document.querySelector('.memory-card')`);
  await clickText('ファイル');
  await until(`document.body.textContent.includes('AGENT.md')`);
  await clickText('AGENT.md');
  await until(`!!document.querySelector('.file-content pre')`);
  await clickText('設定・接続');
  await until(
    `document.body.textContent.includes('追加したい機能') && !!document.querySelector('select[name="providerKind"]')`,
  );
  if (await evaluate(`document.body.textContent.includes('普段のChromeに接続')`))
    throw new Error('Browser-specific configuration is still shown.');
  await screenshot('mcp-settings');
  await setValue('input[name="model"]', 'fixture-model');
  await evaluate(`document.querySelector('form.form-card').requestSubmit()`);
  await clickText('APIキーを入力');
  await until(`!!document.querySelector('input[type="password"]')`);
  await setValue('input[type="password"]', 'browser-only-fixture-secret');
  await clickText('安全に保存');
  await until(
    `document.body.textContent.includes('保存済み') || document.body.textContent.includes('認証を確認しました')`,
  );
  if (await evaluate(`document.body.textContent.includes('browser-only-fixture-secret')`))
    throw new Error('Secret appeared in visible content.');
  if (process.env.VIBE_CODER_TEST_AUTH === '1') {
    await clickText('設定・接続');
    await evaluate(
      `(()=>{const el=document.querySelector('select[name="providerKind"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'codex');el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await until(
      `document.body.textContent.includes('Codexのサブスクで、このエージェントを動かす') && document.querySelector('input[name="model"]')?.value === 'subscription-model'`,
    );
    if (
      await evaluate(
        `!!document.querySelector('form.form-card')?.querySelector('input[name="baseUrl"],input[name="keyRequired"]')`,
      )
    )
      throw new Error('Subscription provider still requires API setup.');
    await clickText('Codexを親AIに設定');
    await until(`document.querySelector('.status-chip')?.textContent.includes('設定済み')`);
    await screenshot('codex-parent');
  }
  if (process.env.VIBE_CODER_TEST_DESKTOP === '1') {
    await clickText('デスクトップ');
    await clickText('画面を開いて手動操作');
    await until(
      `document.body.textContent.includes('接続済み') && !!document.querySelector('.desktop-surface canvas')`,
      15000,
    );
    const canvas = await evaluate(
      `(()=>{const c=document.querySelector('.desktop-surface canvas');return {width:c.width,height:c.height};})()`,
    );
    if (canvas.width !== 800 || canvas.height !== 600)
      throw new Error(`Incorrect VNC framebuffer: ${JSON.stringify(canvas)}`);
    await screenshot('desktop-live');
    await clickText('安全な画面でAIに返す');
    await until(`!document.querySelector('.desktop-surface canvas')`);
  }
  await clickText('新しい会話');
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await Bun.sleep(300);
  await screenshot('mobile');
  const dimensions = await evaluate(
    `({width:innerWidth,body:document.documentElement.scrollWidth})`,
  );
  if (dimensions.body > dimensions.width)
    throw new Error(`Horizontal overflow: ${JSON.stringify(dimensions)}`);
  if (errors.length) throw new Error(`Browser exceptions: ${errors.join(', ')}`);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'login',
        'chat creation',
        'terminal creation and handoff/input',
        'schedule save',
        'memory save',
        'file read',
        'provider config',
        'secret form',
        'mobile layout',
        'generic MCP setup form',
        ...(process.env.VIBE_CODER_TEST_AUTH === '1'
          ? [
              'Codex login card, private code removal, queued continuation and parent subscription selection',
            ]
          : []),
        ...(process.env.VIBE_CODER_TEST_NATIVE === '1'
          ? ['native output, turn state and session continuation']
          : []),
        ...(process.env.VIBE_CODER_TEST_DESKTOP === '1' ? ['live VNC in WebUI and handoff'] : []),
      ],
      screenshots: '/tmp/vibe-coder-browser',
      dimensions,
    }),
  );
} catch (error) {
  console.error(
    await evaluate(`({url:location.href,body:document.body?.innerText?.slice(0,4000)})`),
  );
  await screenshot('failure');
  throw error;
} finally {
  await command('Target.disposeBrowserContext', { browserContextId });
  ws.close();
}
