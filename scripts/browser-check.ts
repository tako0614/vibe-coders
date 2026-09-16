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
const basicAuth = process.env.VIBE_CODER_TEST_BASIC === '1';
const browserOrigin = process.env.VIBE_CODER_TEST_ORIGIN || 'http://127.0.0.1:5173';
const errors: string[] = [];
await command('Runtime.enable', {}, sessionId);
await command('Network.enable', {}, sessionId);
await command('Page.enable', {}, sessionId);
const old = ws.onmessage!;
ws.onmessage = (event) => {
  const data = JSON.parse(String(event.data));
  if (data.sessionId === sessionId && data.method === 'Fetch.requestPaused')
    void command('Fetch.continueRequest', { requestId: data.params.requestId }, sessionId).catch(
      () => {},
    );
  if (data.sessionId === sessionId && data.method === 'Fetch.authRequired')
    void command(
      'Fetch.continueWithAuth',
      {
        requestId: data.params.requestId,
        authChallengeResponse:
          new URL(data.params.request.url).origin === new URL(browserOrigin).origin
            ? {
                response: 'ProvideCredentials',
                username: 'owner',
                password: 'test-only-password-123',
              }
            : { response: 'CancelAuth' },
      },
      sessionId,
    ).catch(() => {});
  if (data.sessionId === sessionId && data.method === 'Runtime.exceptionThrown')
    errors.push(data.params.exceptionDetails.text);
  old.call(ws, event);
};
mkdirSync('/tmp/vibe-coder-browser', { recursive: true });
try {
  if (basicAuth)
    await command(
      'Fetch.enable',
      { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] },
      sessionId,
    );
  const navigation = await command(
    'Page.navigate',
    { url: process.env.VIBE_CODER_TEST_ORIGIN || 'http://127.0.0.1:5173' },
    sessionId,
  );
  if (navigation.errorText) throw new Error(navigation.errorText);
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  if (!basicAuth) {
    await until(`!!document.querySelector('input[name="username"]')`);
    await setValue('input[name="username"]', 'owner');
    await setValue('input[name="password"]', 'test-only-password-123');
    await evaluate(`document.querySelector('form').requestSubmit()`);
  }
  await until(`!!document.querySelector('.welcome')`);
  await screenshot('desktop');
  await setValue('.composer textarea', '送信済みの下書きを残さない');
  await evaluate(`document.querySelector('button[aria-label="メッセージを送信"]').click()`);
  await until(`!!document.querySelector('.provider-picker')`);
  await until(
    `new Promise(done => { const r = indexedDB.open('vibe-coders-drafts'); r.onsuccess = () => { const db = r.result, g = db.transaction('drafts').objectStore('drafts').getAll(); g.onsuccess = () => { done(!g.result.some(d => d.text === '送信済みの下書きを残さない')); db.close(); }; }; })`,
  );
  await clickText('チャット');
  await until(`document.querySelector('.composer textarea')?.value === ''`);

  const previousChats = await evaluate(
    `document.querySelectorAll('.conversation-list button').length`,
  );
  await clickText('新しい会話');
  await until(`document.querySelectorAll('.conversation-list button').length > ${previousChats}`);
  await clickText('ターミナル');
  if (process.env.VIBE_CODER_TEST_AUTH === '1') {
    const authState = process.env.VIBE_CODER_TEST_AUTH_STATE;
    if (!authState) throw new Error('Use the fixture auth-state path.');
    await evaluate(
      `(async()=>{const headers={'Authorization':'Basic '+btoa('owner:test-only-password-123'),'X-Vibe-Coder':'1','Content-Type':'application/json'};const status=await(await fetch('/api/status',{headers})).json(); const response=await fetch('/api/codex/auth/login',{method:'POST',headers,body:JSON.stringify({conversationId:status.conversations[0].id,method:'device'})}); if(!response.ok)throw Error(await response.text());})()`,
    );
    await clickText('入力依頼');
    await until(
      `document.querySelector('.codex-login-details')?.textContent.includes('PRIVATE-CODE-234')`,
    );
    await screenshot('codex-login');
    await Bun.write(authState, JSON.stringify({ signedIn: true, finish: true }));
    await until(`!!document.querySelector('.request-history')`);
    if (await evaluate(`document.body.textContent.includes('PRIVATE-CODE-234')`))
      throw new Error('Completed login code remained visible.');
    await clickText('ターミナル');
  }
  await clickText('ターミナルを開く');
  await until(`!!document.querySelector('.terminal-surface .xterm-helper-textarea')`);
  await until(`document.body.textContent.includes('あなたが操作中')`);
  await Bun.sleep(600);
  const terminalHeight = await evaluate(
    `document.querySelector('.terminal-surface').getBoundingClientRect().height`,
  );
  if (terminalHeight < 300 || terminalHeight > 750)
    throw new Error(`Terminal resize feedback loop: ${terminalHeight}`);
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
  await until(`document.querySelector('.xterm-rows')?.textContent.includes('browser-terminal-ok')`);
  await evaluate(`document.querySelector('button[aria-label="貼り付け"]').click()`);
  await setValue('.terminal-paste textarea', 'printf "browser-paste-ok"');
  await evaluate(`document.querySelector('.terminal-paste').requestSubmit()`);
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
  await until(`document.querySelector('.xterm-rows')?.textContent.includes('browser-paste-ok')`);
  await evaluate(`document.querySelector('button[aria-label="文字を大きく"]').click()`);
  await evaluate(`document.querySelector('button[aria-label="文字を小さく"]').click()`);
  await evaluate(`document.querySelector('button[aria-label="端末へ再接続"]').click()`);
  await until(`document.querySelector('.terminal-connection')?.textContent === '接続済み'`);
  await until(`document.querySelector('.xterm-rows')?.textContent.includes('browser-paste-ok')`);
  await screenshot('terminal');
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await until(`document.documentElement.scrollWidth === 390`);
  await screenshot('terminal-mobile');
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  // Two real PTYs remain alive and mounted across decks, focus and maximization.
  const firstRun = await evaluate(`document.querySelector('.shell-tile').dataset.runId`);
  const firstTile = `.shell-tile[data-run-id="${firstRun}"]`;
  const terminalCommand = async (selector: string, text: string) => {
    await until(
      `document.querySelector(${JSON.stringify(selector + ' .terminal-connection')})?.textContent === '接続済み'`,
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(selector + ' .xterm-helper-textarea')}).focus()`,
    );
    await command('Input.insertText', { text }, sessionId);
    for (const type of ['keyDown', 'keyUp'])
      await command(
        'Input.dispatchKeyEvent',
        { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        sessionId,
      );
  };
  await terminalCommand(firstTile, 'export DECK_PROOF=shared-shell-works');
  await clickText('ターミナルを開く');
  await until(`document.querySelectorAll('.shell-tile').length === 2`);
  await evaluate(
    `window.__firstTerminal=document.querySelector(${JSON.stringify(firstTile + ' .xterm')})`,
  );
  await screenshot('shell-grid');
  await evaluate(`document.querySelector('button[aria-label="選択した端末を最大化"]').click()`);
  await until(
    `Array.from(document.querySelectorAll('.shell-tile')).filter(e=>e.getBoundingClientRect().width>0).length===1`,
  );
  await evaluate(`document.querySelector('button[aria-label="端末を並べて表示"]').click()`);
  await evaluate(`document.querySelector('button[aria-label="デッキを追加"]').click()`);
  await until(`!!document.querySelector('.deck-editor input')`);
  await setValue('.deck-editor input', '検証デッキ');
  await evaluate(`document.querySelector('.deck-editor').requestSubmit()`);
  await until(
    `Array.from(document.querySelectorAll('[role="tab"]')).some(e=>e.textContent.includes('検証デッキ'))`,
  );
  await evaluate(`document.querySelector('[role="tab"]').click()`);
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).getBoundingClientRect().width>0`,
  );
  await evaluate(
    `(()=>{const el=document.querySelector(${JSON.stringify(firstTile + ' select[aria-label="端末の移動先デッキ"]')});el.value=el.options[1].value;el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).getBoundingClientRect().width===0`,
  );
  await evaluate(
    `Array.from(document.querySelectorAll('[role="tab"]')).find(e=>e.textContent.includes('検証デッキ')).click()`,
  );
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).getBoundingClientRect().width>0`,
  );
  if (
    !(await evaluate(
      `window.__firstTerminal===document.querySelector(${JSON.stringify(firstTile + ' .xterm')})`,
    ))
  )
    throw new Error('Deck move remounted the terminal');
  await terminalCommand(firstTile, 'printf "VALUE=%s\\n" "$DECK_PROOF"');
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).textContent.includes('VALUE=shared-shell-works')`,
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(firstTile + ' button[aria-label="端末の表示を閉じる"]')}).click()`,
  );
  await until(`!document.querySelector(${JSON.stringify(firstTile)})`);
  await evaluate(`document.querySelector('.shell-archive').open=true`);
  await clickText('表示を戻す');
  await until(`!!document.querySelector(${JSON.stringify(firstTile + ' .xterm')})`);
  await terminalCommand(firstTile, 'printf "RESTORED=%s\\n" "$DECK_PROOF"');
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).textContent.includes('RESTORED=shared-shell-works')`,
  );
  await clickText('コマンドから開く');
  await setValue('.shell-launch input[name="command"]', 'cat');
  await setValue('.shell-launch input[name="title"]', 'JSON pipe');
  await evaluate(
    `(()=>{const el=document.querySelector('.shell-launch select[name="mode"]');el.value='pipe';el.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.shell-launch').requestSubmit();})()`,
  );
  await until(`!!document.querySelector('.pipe-input textarea:not(:disabled)')`);
  await setValue('.pipe-input textarea', '{"text":"日本語 pipe"}');
  await evaluate(`document.querySelector('.pipe-input').requestSubmit()`);
  await until(
    `document.querySelector('.pipe-view .run-output').textContent.includes('日本語 pipe')`,
  );
  await clickText('入力を終了（EOF）');
  await until(
    `Array.from(document.querySelectorAll('.shell-tile-footer')).some(e=>e.textContent.includes('終了コード 0'))`,
  );
  await screenshot('shell-deck-pipe');
  await command('Page.reload', {}, sessionId);
  if (!basicAuth) {
    await until(`!!document.querySelector('input[name="username"]')`);
    await setValue('input[name="username"]', 'owner');
    await setValue('input[name="password"]', 'test-only-password-123');
    await evaluate(`document.querySelector('form').requestSubmit()`);
  }
  await clickText('ターミナル');
  await until(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes('検証デッキ')`,
  );
  await until(`!!document.querySelector(${JSON.stringify(firstTile + ' .xterm-helper-textarea')})`);
  await terminalCommand(firstTile, 'printf "RELOADED=%s\\n" "$DECK_PROOF"');
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).textContent.includes('RELOADED=shared-shell-works')`,
  );
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await until(`document.documentElement.scrollWidth===390`);
  await until(
    `Array.from(document.querySelectorAll('.shell-tile')).filter(e=>e.getBoundingClientRect().width>0).length===1`,
  );
  await screenshot('shell-mobile');
  await command(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  // Human/agent ownership changes affect the same PTY, and deleting a deck moves it.
  await evaluate(
    `Array.from(document.querySelector(${JSON.stringify(firstTile)}).querySelectorAll('button')).find(e=>e.textContent.includes('AIに返す')).click()`,
  );
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).textContent.includes('AIが操作中')`,
  );
  await until(
    `document.querySelector(${JSON.stringify(firstTile + ' button[aria-label="貼り付け"]')}).disabled`,
  );
  await evaluate(
    `Array.from(document.querySelector(${JSON.stringify(firstTile)}).querySelectorAll('button')).find(e=>e.textContent.includes('手動操作')).click()`,
  );
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).textContent.includes('あなたが操作中')`,
  );
  await terminalCommand(firstTile, 'printf "HANDED_BACK=%s\\n" "$DECK_PROOF"');
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).textContent.includes('HANDED_BACK=shared-shell-works')`,
  );
  await evaluate(`document.querySelector('button[aria-label="デッキを編集"]').click()`);
  await evaluate(`document.querySelector('button[aria-label="デッキを左へ"]').click()`);
  await until(`document.querySelector('[role="tab"]')?.textContent.includes('検証デッキ')`);
  await clickText('デッキを削除・端末は移動');
  await until(`document.querySelectorAll('[role="tab"]').length===1`);
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).getBoundingClientRect().width>0`,
  );
  await terminalCommand(firstTile, 'printf "DELETED_DECK=%s\\n" "$DECK_PROOF"');
  await until(
    `document.querySelector(${JSON.stringify(firstTile)}).textContent.includes('DELETED_DECK=shared-shell-works')`,
  );
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
  const originalFile = await evaluate(`document.querySelector('.file-content pre').textContent`);
  await clickText('編集する');
  await until(`!!document.querySelector('.file-editor textarea')`);
  await setValue('.file-editor textarea', originalFile + '\nBROWSER_EDIT_PROOF\n');
  await clickText('ファイルを保存');
  await until(
    `(()=>{const button=document.querySelector('.file-editor button.primary');return button?.disabled && button.textContent==='ファイルを保存';})()`,
  );
  await clickText('変更を確認');
  await until(`!!document.querySelector('.change-list button')`);
  await clickText('AGENT.md');
  await until(`document.querySelector('.file-diff')?.textContent.includes('+BROWSER_EDIT_PROOF')`);
  await screenshot('file-changes');
  await clickText('変更前に戻す');
  await clickText('このファイルを復元');
  await until(`!document.querySelector('.change-list button')`);
  await clickText('ファイル一覧へ');
  await until(`!!document.querySelector('.file-browser')`);
  await clickText('AGENT.md');
  await until(
    `!!document.querySelector('.file-content pre') && !document.querySelector('.file-content pre').textContent.includes('BROWSER_EDIT_PROOF')`,
  );

  await clickText('設定・接続');
  await until(`!!document.querySelector('.provider-picker')`);
  await clickText('MCP');
  await until(`document.querySelector('textarea[name="request"]')?.checkVisibility()`);
  if (await evaluate(`document.body.textContent.includes('普段のChromeに接続')`))
    throw new Error('Browser-specific configuration is still shown.');
  await until(`!!document.querySelector('.mcp-install')`);
  await evaluate(`document.querySelector('.mcp-install').open = true`);
  if (await evaluate(`document.querySelector('.mcp-install button.primary').disabled`))
    throw new Error('npm installation depends on the AI provider');
  if (process.env.VIBE_CODER_TEST_INSTALL === '1') {
    await setValue('.mcp-install input[name="name"]', 'browser-installed');
    await setValue('.mcp-install input[name="package"]', 'chrome-devtools-mcp');
    await setValue('.mcp-install input[name="version"]', '1.9.0');
    await setValue(
      '.mcp-install input[name="args"]',
      JSON.stringify([
        '--browser-url=' + endpoint,
        '--no-usage-statistics',
        '--no-performance-crux',
      ]),
    );
    await evaluate(`document.querySelector('.mcp-install form').requestSubmit()`);
    await until(
      `Array.from(document.querySelectorAll('.connection-row')).some(r => r.textContent.includes('browser-installed') && r.textContent.includes('接続済み') && r.textContent.includes('29 tools'))`,
      180000,
    );
  }
  await screenshot('mcp-settings');
  await clickText('AI接続');
  await evaluate(
    `Array.from(document.querySelectorAll('.provider-picker button')).find(b=>b.textContent.includes('APIキー')).click()`,
  );
  await setValue('input[name="model"]', 'fixture-model');
  await evaluate(`document.querySelector('form.form-card').requestSubmit()`);
  await until(`!!document.querySelector('input[type="password"]')`);
  await setValue('input[type="password"]', 'browser-only-fixture-secret');
  await clickText('安全に保存');
  await until(`!!document.querySelector('.request-history')`);
  await evaluate(`document.querySelector('.request-history').open=true`);
  await until(
    `document.body.textContent.includes('保存済み') || document.body.textContent.includes('認証を確認しました')`,
  );
  if (await evaluate(`document.body.textContent.includes('browser-only-fixture-secret')`))
    throw new Error('Secret appeared in visible content.');
  if (process.env.VIBE_CODER_TEST_AUTH === '1') {
    await clickText('設定・接続');
    await until(`!!document.querySelector('.provider-picker')`);
    await evaluate(
      `Array.from(document.querySelectorAll('.provider-picker button')).find(b=>b.textContent.includes('Codex')).click()`,
    );
    await until(`document.querySelector('select[name="model"]')?.value === 'subscription-model'`);
    if (
      await evaluate(
        `!!document.querySelector('.provider-card input[name="baseUrl"],.provider-card input[name="keyRequired"]')`,
      )
    )
      throw new Error('Subscription provider still requires API setup.');
    await clickText('このモデルでチャットを始める');
    await until(
      `document.querySelector('.model-label')?.textContent.includes('subscription-model')`,
    );
    await clickText('設定・接続');
    await until(
      `document.querySelector('.provider-card .status-chip')?.textContent.includes('接続済み')`,
    );
    await screenshot('codex-parent');
  }
  if (process.env.VIBE_CODER_TEST_DESKTOP === '1') {
    await clickText('デスクトップ');
    await until(`!!document.querySelector('.desktop-page')`);
    if (
      await evaluate(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('画面を開いて手動操作'))`,
      )
    )
      await clickText('画面を開いて手動操作');
    await until(
      `document.querySelector('.desktop-surface canvas')?.width === 800 && document.querySelector('.desktop-surface canvas')?.height === 600`,
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
  await setValue('.composer textarea', '画面を切り替えても残る下書き');
  await clickText('ファイル');
  await until(`!!document.querySelector('.file-browser')`);
  await clickText('チャット');
  await until(
    `document.querySelector('.composer textarea')?.value === '画面を切り替えても残る下書き'`,
  );
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], 'draft.png', { type: 'image/png' }));
    const input = document.querySelector('input[type="file"]'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(`document.querySelectorAll('.attachment-preview img').length === 1`);
  await until(
    `new Promise(resolve => { const req = indexedDB.open('vibe-coders-drafts', 1); req.onsuccess = () => { const db = req.result, tx = db.transaction('drafts'); const get = tx.objectStore('drafts').getAll(); get.onsuccess = () => { resolve(get.result.some(d => d.text === '画面を切り替えても残る下書き' && d.images.length === 1)); db.close(); }; }; })`,
  );
  await evaluate('window.__draftReloadPending = true');
  await command('Page.reload', {}, sessionId);
  await until(
    `!window.__draftReloadPending && (!!document.querySelector('input[name="username"]') || !!document.querySelector('.composer'))`,
  );
  if (await evaluate(`!!document.querySelector('input[name="username"]')`)) {
    await setValue('input[name="username"]', 'owner');
    await setValue('input[name="password"]', 'test-only-password-123');
    await evaluate(`document.querySelector('form').requestSubmit()`);
  }
  await until(
    `!window.__draftReloadPending && document.readyState === 'complete' && document.querySelector('.composer textarea')?.value === '画面を切り替えても残る下書き' && document.querySelectorAll('.attachment-preview img').length === 1`,
  );
  await command(
    'Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    sessionId,
  );
  await until(`document.querySelector('.daemon-status')?.textContent.includes('再接続中')`);
  await command(
    'Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    sessionId,
  );
  await until(`document.querySelector('.daemon-status')?.textContent.includes('サーバー接続済み')`);
  await command(
    'Network.emulateNetworkConditions',
    { offline: false, latency: 800, downloadThroughput: -1, uploadThroughput: -1 },
    sessionId,
  );
  await clickText('ファイル');
  await until(
    `Array.from(document.querySelectorAll('.file-list button')).some(b=>b.textContent==='AGENT.md')`,
  );
  await clickText('AGENT.md');
  await clickText('atom.toml');
  await until(
    `document.querySelector('.file-info code')?.textContent==='atom.toml' && !document.querySelector('.file-content[aria-busy="true"]')`,
  );
  await command(
    'Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    sessionId,
  );
  await clickText('チャット');
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
        'terminal creation with immediate human input',
        'terminal paste, font sizing, reconnect and mobile controls',
        'deck grid, maximization, move without remount, hidden PTY, writable JSON pipe and EOF, reload persistence and mobile switching',
        'draft retention, reconnect status and rapid file selection',
        'schedule save',
        'memory save',
        'file edit, diff and guarded restore',
        'text and image drafts survive page reload; send clears storage before navigation',
        'provider config',
        'secret form',
        'mobile layout',
        'MCP setup and provider-independent npm installation form',
        ...(process.env.VIBE_CODER_TEST_AUTH === '1'
          ? [
              'Codex login card, private code removal, queued continuation and parent subscription selection',
            ]
          : []),

        ...(process.env.VIBE_CODER_TEST_INSTALL === '1'
          ? ['real npm installation and MCP discovery from WebUI']
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
