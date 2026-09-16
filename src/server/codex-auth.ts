import { JsonProcess } from './json-process';
import { Store } from './store';
import { HumanService } from './human';
import { Desktop } from './desktop';
import { eq } from 'drizzle-orm';
import { requests } from './db/schema';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { shellEnvironment } from './runs';
import { reasoningChoices, type ModelChoice } from '../shared/models';

type AuthState =
  'unchecked' | 'missing' | 'signed_out' | 'starting' | 'waiting' | 'signed_in' | 'ready' | 'error';
const credentialUnavailable =
  '端末のCodexはログイン済みですが、利用できるauth.jsonがありません。keyringのみの認証には未対応です。';
type Attempt = {
  requestId: string;
  process?: JsonProcess;
  loginId?: string;
  details?: { url: string; code?: string };
  notification?: { loginId: string; success: boolean };
  timer?: ReturnType<typeof setTimeout>;
  ending: boolean;
  done: Promise<boolean>;
  finish: (success: boolean) => void;
};

export class CodexAuth {
  private state: AuthState = 'unchecked';
  private ready = false;
  private mode: string | null = null;
  private message = '';
  private credentialSource: 'native-file' | null = null;
  private active?: Attempt;
  private closed = false;
  private probes = new Set<JsonProcess>();
  private checking?: Promise<ReturnType<CodexAuth['status']>>;
  private catalogAbort = new AbortController();
  private catalogLoading?: Promise<ModelChoice[]>;
  constructor(
    readonly store: Store,
    readonly human: HumanService,
    readonly desktop: Desktop,
    readonly home: string,
    readonly command = ['codex'],
    readonly credentialFile = join(
      process.env.CODEX_HOME || join(homedir(), '.codex'),
      'auth.json',
    ),
  ) {
    store.changes.on('change', this.checkLifecycle);
  }

  status() {
    const installed = !!Bun.which(this.command[0]);
    return {
      installed,
      state: installed || this.ready ? this.state : ('missing' as AuthState),
      ready: this.ready,
      subscriptionReady:
        this.ready && this.mode === 'chatgpt' && this.credentialSource === 'native-file',
      credentialSource: this.credentialSource,
      mode: this.mode,
      message: this.message,
      ...(this.active ? { requestId: this.active.requestId } : {}),
    };
  }
  // Only authenticated user routes may return these ephemeral sign-in details.
  userStatus() {
    return {
      ...this.status(),
      desktopOwner: this.desktop.list()[0]?.owner,
      desktopId: this.desktop.list()[0]?.id,
      login: this.active?.details || null,
    };
  }
  private notify() {
    if (!this.closed) this.store.notify();
  }
  recover() {
    // A login RPC belongs to the former process. Never leave a resumable-looking
    // card when its ephemeral authorization attempt no longer exists.
    for (const card of this.store.db
      .select()
      .from(requests)
      .where(eq(requests.state, 'pending'))
      .all())
      if (card.spec.targetId === 'codex' && card.spec.externalCompletion) this.human.close(card.id);
  }
  private async open() {
    if (this.closed) throw new Error('Codex authentication is closed.');
    if (!Bun.which(this.command[0])) throw new Error('Install the Codex CLI first.');
    const client = new JsonProcess([...this.command, 'app-server', '--stdio'], this.home, () => {});
    this.probes.add(client);
    try {
      await client.request(
        'initialize',
        { clientInfo: { name: 'vibe_coders', version: '0.3.3' } },
        10000,
      );
      client.send({ method: 'initialized', params: {} });
      return client;
    } catch (error) {
      await this.closeClient(client);
      throw error;
    }
  }
  private async closeClient(client: JsonProcess) {
    await client.close();
    this.probes.delete(client);
  }
  private account(value: any) {
    this.ready = !!value.account || value.requiresOpenaiAuth === false;
    this.mode = typeof value.account?.type === 'string' ? value.account.type : null;
    this.state = value.account ? 'signed_in' : this.ready ? 'ready' : 'signed_out';
    this.message = '';
  }
  async refresh(refreshToken = false) {
    this.store.assertEnabled();
    if (this.active) return this.status();
    if (this.checking) {
      await this.checking;
      if (!refreshToken) return this.status();
    }
    this.checking = (async () => {
      let client: JsonProcess | undefined;
      try {
        this.credentialSource = null;
        const saved = await this.readCredentials().catch(() => null);
        if (this.active || this.closed) return this.status();
        if (!refreshToken && saved && (!saved.expires || saved.expires > Date.now() + 60000)) {
          this.account({ account: { type: 'chatgpt' } });
          this.credentialSource = 'native-file';
          this.notify();
          return this.status();
        }
        client = await this.open();
        const account = await client.request(
          'account/read',
          { refreshToken: refreshToken || !!saved },
          10000,
        );
        if (!this.active && !this.closed) this.account(account);
        if (this.mode === 'chatgpt' && (await this.readCredentials().catch(() => null)))
          this.credentialSource = 'native-file';
        if (this.mode === 'chatgpt' && !this.credentialSource) this.message = credentialUnavailable;
      } catch {
        if (!this.active && !this.closed) {
          this.ready = false;
          this.state = Bun.which(this.command[0]) ? 'error' : 'missing';
          this.message =
            this.state === 'missing'
              ? 'Codex CLIを導入してください。'
              : 'Codexの認証状態を確認できませんでした。';
        }
      } finally {
        if (client) await this.closeClient(client);
      }
      this.notify();
      return this.status();
    })();
    try {
      return await this.checking;
    } finally {
      this.checking = undefined;
    }
  }
  // Server-only access to Codex's existing credential file. Never copied into
  // Vibe Coders settings, tool results, responses, logs or model input.
  private async readCredentials() {
    try {
      const file = Bun.file(this.credentialFile);
      if (file.size > 256 * 1024) throw new Error();
      const auth = await file.json();
      const token = auth.tokens?.access_token,
        accountId = auth.tokens?.account_id;
      if (
        (auth.auth_mode && auth.auth_mode !== 'chatgpt') ||
        auth.OPENAI_API_KEY ||
        typeof token !== 'string' ||
        !token ||
        typeof accountId !== 'string' ||
        !accountId ||
        /[\r\n]/.test(token + accountId)
      )
        throw new Error();
      let expires = 0;
      try {
        expires =
          Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp) * 1000;
      } catch {}
      return { token, accountId, expires };
    } catch {
      throw new Error('CODEX_LOGIN_REQUIRED');
    }
  }
  async subscriptionCredentials(forceRefresh = false) {
    this.store.assertEnabled();
    if (this.active) throw new Error('CODEX_LOGIN_REQUIRED');
    let value = await this.readCredentials().catch((error) => {
      if (this.ready && this.mode === 'chatgpt') throw new Error('CODEX_CREDENTIALS_UNAVAILABLE');
      throw error;
    });
    if (forceRefresh || (value.expires && value.expires < Date.now() + 60000)) {
      if (!(await this.refresh(true)).subscriptionReady) throw new Error('CODEX_LOGIN_REQUIRED');
      value = await this.readCredentials();
      if (value.expires && value.expires < Date.now()) throw new Error('CODEX_LOGIN_REQUIRED');
    }
    if (!this.ready || this.mode !== 'chatgpt' || !this.credentialSource) {
      this.account({ account: { type: 'chatgpt' } });
      this.credentialSource = 'native-file';
      this.notify();
    }
    return { token: value.token, accountId: value.accountId };
  }
  async models() {
    this.store.assertEnabled();
    if (this.closed) throw new Error('Codex authentication is closed.');
    if (this.catalogLoading) return this.catalogLoading;
    // The catalog command refreshes through Codex's own auth/config and avoids
    // opening its conversation DB, which may be busy in another native session.
    this.catalogLoading = this.catalogModels().catch(() => this.rpcModels());
    try {
      return await this.catalogLoading;
    } finally {
      this.catalogLoading = undefined;
    }
  }
  private async catalogModels(): Promise<ModelChoice[]> {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.command[0],
        [...this.command.slice(1), 'debug', 'models'],
        {
          cwd: this.home,
          env: shellEnvironment(),
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          signal: this.catalogAbort.signal,
        },
        (error, out) => (error ? reject(new Error('Codex catalog unavailable.')) : resolve(out)),
      );
    });
    const catalog = JSON.parse(stdout);
    if (!Array.isArray(catalog.models) || catalog.models.length > 2000)
      throw new Error('Invalid catalog.');
    const choices = catalog.models
      .filter(
        (m: any) =>
          m.visibility === 'list' &&
          typeof m.slug === 'string' &&
          m.slug.length > 0 &&
          m.slug.length <= 200,
      )
      .sort((a: any, b: any) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
    if (!choices.length) throw new Error('Empty catalog.');
    return choices.map((m: any, index: number) => ({
      id: m.slug,
      name: typeof m.display_name === 'string' ? m.display_name.slice(0, 200) : m.slug,
      isDefault: index === 0,
      ...reasoningChoices(
        m.supported_reasoning_levels?.map((v: any) => v.effort),
        m.default_reasoning_level,
      ),
    }));
  }
  // Older CLI versions may only expose the App Server catalog.
  private async rpcModels() {
    const client = await this.open();
    try {
      const result: ModelChoice[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const response = await client.request(
          'model/list',
          { ...(cursor ? { cursor } : {}), includeHidden: false },
          10000,
        );
        for (const model of response.data || [])
          if (typeof model.model === 'string' && !model.hidden)
            result.push({
              id: model.model,
              name: model.displayName || model.model,
              isDefault: !!model.isDefault,
              ...reasoningChoices(
                model.supportedReasoningEfforts?.map((v: any) => v.reasoningEffort),
                model.defaultReasoningEffort,
              ),
            });
        cursor = response.nextCursor;
        if (!cursor) return result;
      }
      throw new Error('Too many model pages.');
    } finally {
      await this.closeClient(client);
    }
  }
  start(conversationId: string, method: 'device' | 'browser' = 'device', force = false) {
    this.store.assertEnabled();
    if (this.closed) throw new Error('Codex authentication is closed.');
    this.store.conversation(conversationId);
    if (this.active) return this.status();
    if (!Bun.which(this.command[0])) throw new Error('Install the Codex CLI first.');
    const card = this.human.create(conversationId, {
      kind: 'action',
      targetId: 'codex',
      title: 'Codexにログイン',
      message: 'このカードの認証画面を使ってログインしてください。完了はCodexから確認します。',
      externalCompletion: true,
      expiresAt: Date.now() + 15 * 60000,
    });
    let finish!: (success: boolean) => void;
    const attempt: Attempt = {
      requestId: card.id,
      ending: false,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      finish: (success) => finish(success),
    };
    this.active = attempt;
    this.credentialSource = null;
    this.state = 'starting';
    this.ready = false;
    this.message = '';
    attempt.timer = setTimeout(() => {
      void this.end(attempt, false, 'ログインの期限が切れました。再度開始してください。');
    }, 15 * 60000);
    this.notify();
    void this.begin(attempt, method, force).catch(() =>
      this.end(
        attempt,
        false,
        'ログインを開始できませんでした。Codex CLIと認証方式を確認してください。',
      ),
    );
    return this.status();
  }
  private async begin(attempt: Attempt, method: 'device' | 'browser', force: boolean) {
    const client = await this.open();
    if (attempt !== this.active || attempt.ending) {
      await this.closeClient(client);
      return;
    }
    attempt.process = client;
    const account = await client.request('account/read', { refreshToken: false }, 10000);
    if (attempt !== this.active || attempt.ending) return;
    if (!force && account.account?.type === 'chatgpt') {
      this.account(account);
      if (await this.readCredentials().catch(() => null)) this.credentialSource = 'native-file';
      await this.end(attempt, true, this.credentialSource ? '' : credentialUnavailable);
      return;
    }
    this.desktop.get().handoff('human');
    client.events.on('message', (message) => {
      if (message.method !== 'account/login/completed') return;
      const event = message.params;
      if (!event || typeof event.loginId !== 'string' || typeof event.success !== 'boolean') return;
      attempt.notification = { loginId: event.loginId, success: event.success };
      void this.completed(attempt).catch(() =>
        this.end(attempt, false, 'ログイン結果を確認できませんでした。'),
      );
    });
    client.events.on('ended', () => {
      void this.end(attempt, false, 'Codexとの認証接続が終了しました。');
    });
    const login = await client.request('account/login/start', {
      type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt',
    });
    if (attempt !== this.active || attempt.ending) return;
    if (typeof login.loginId !== 'string') throw new Error('Invalid login response.');
    attempt.loginId = login.loginId;
    const url = new URL(method === 'device' ? login.verificationUrl : login.authUrl);
    if (
      url.protocol !== 'https:' ||
      !['auth.openai.com', 'auth.chatgpt.com', 'chatgpt.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.href.length > 8000
    )
      throw new Error('Invalid Codex sign-in URL.');
    if (method === 'device' && (typeof login.userCode !== 'string' || login.userCode.length > 128))
      throw new Error('Invalid login code.');
    attempt.details = { url: url.href, ...(method === 'device' ? { code: login.userCode } : {}) };
    this.state = 'waiting';
    this.notify();
    await this.completed(attempt);
  }
  private async completed(attempt: Attempt) {
    if (
      attempt !== this.active ||
      attempt.ending ||
      !attempt.loginId ||
      attempt.notification?.loginId !== attempt.loginId
    )
      return;
    const event = attempt.notification;
    attempt.notification = undefined;
    if (!event.success) {
      await this.end(attempt, false, 'ログインが完了しませんでした。再度開始してください。');
      return;
    }
    const account = await attempt.process!.request('account/read', { refreshToken: false }, 10000);
    if (attempt !== this.active || attempt.ending) return;
    this.account(account);
    if (this.mode === 'chatgpt' && (await this.readCredentials().catch(() => null)))
      this.credentialSource = 'native-file';
    await this.end(
      attempt,
      this.ready,
      this.ready
        ? this.credentialSource
          ? ''
          : credentialUnavailable
        : 'Codexのログイン状態を確認できませんでした。',
    );
  }
  private async end(attempt: Attempt, success: boolean, message = '') {
    if (this.active !== attempt || attempt.ending) return;
    attempt.ending = true;
    clearTimeout(attempt.timer);
    attempt.details = undefined;
    if (!success && attempt.process && attempt.loginId)
      await attempt.process
        .request('account/login/cancel', { loginId: attempt.loginId }, 2000)
        .catch(() => {});
    if (attempt.process) await this.closeClient(attempt.process);
    this.active = undefined;
    this.ready = success;
    if (!success) {
      this.state = 'signed_out';
      this.mode = null;
    }
    this.message = message;
    if (success)
      this.human.completeExternal(attempt.requestId, {
        verification: 'verified',
        targetId: 'codex',
        authenticated: true,
      });
    else this.human.close(attempt.requestId);
    attempt.finish(success);
    this.notify();
  }
  private checkLifecycle = () => {
    const attempt = this.active;
    if (
      attempt &&
      !attempt.ending &&
      (this.store.stopped || this.human.get(attempt.requestId).state !== 'pending')
    )
      void this.end(attempt, false, 'ログインを中止しました。');
  };
  async cancel() {
    const attempt = this.active;
    if (attempt) {
      await this.end(attempt, false, 'ログインを中止しました。');
      await attempt.done;
    }
    return this.status();
  }
  async ensure(conversationId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.active && (await this.refresh()).ready) return;
    signal.throwIfAborted();
    this.start(conversationId);
    const attempt = this.active;
    if (!attempt) throw new Error('Codex sign-in could not start.');
    const success = await new Promise<boolean>((resolve, reject) => {
      const abort = () => {
        reject(new Error('Native run was cancelled during sign-in.'));
      };
      signal.addEventListener('abort', abort, { once: true });
      void attempt.done.then((value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    if (!success) throw new Error('Codex sign-in was not completed.');
  }
  async close() {
    this.catalogAbort.abort();
    this.closed = true;
    this.store.changes.off('change', this.checkLifecycle);
    await this.cancel();
    await Promise.all([...this.probes].map((client) => this.closeClient(client)));
  }
}
