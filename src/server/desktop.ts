import { Config, Vault, type HostConfig } from './config';
import { Store } from './store';
import { shellEnvironment } from './runs';
import { RfbClient } from './rfb';
import { DesktopHost } from './desktop-host';
import { desktopDefinitionSchema } from '../shared/contracts';
import { eq, inArray } from 'drizzle-orm';
import { requests, runs, state } from './db/schema';
import { readFileSync } from 'node:fs';

const connectionIdentity = (d: HostConfig['desktops'][number]) =>
  JSON.stringify([d.kind, d.revision, d.connection && { ...d.connection, name: undefined }]);

export class DesktopSession {
  private closed = false;
  readonly host?: DesktopHost;
  private previews = new Set<RfbClient>();
  private sessions = new Set<RfbClient>();
  private cachedVnc?: { client: RfbClient; epoch: number; revision: number };
  private vncBusy = false;
  private processes = new Set<{ kill: () => void }>();
  private changed = () => {
    if (this.store.stopped) for (const c of this.previews) c.close();
    if (this.store.stopped || this.status().owner === 'human') {
      for (const c of this.sessions) c.close();
      for (const p of this.processes) p.kill();
    }
  };
  private observation?: {
    id: string;
    epoch: number;
    revision: number;
    width: number;
    height: number;
  };
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly vault: Vault,
    readonly definition: HostConfig['desktops'][number],
    options?: { home: string; directory: string },
  ) {
    if (options)
      this.host = new DesktopHost(
        options.home,
        options.directory,
        () => store.notify(),
        definition.id,
      );
    store.changes.on('change', this.changed);
  }
  status() {
    const c = this.target();
    return {
      id: this.definition.id,
      kind: this.definition.kind,
      revision: this.definition.revision,
      configured: !!c && !this.closed,
      setup: c ? ('ready' as const) : this.host?.state || ('idle' as const),
      source: this.definition.connection ? ('manual' as const) : this.host?.source,
      message: this.host?.message || '',
      automatic: !this.definition.connection,
      name: this.definition.name,
      display: c?.display,
      host: 'backend host',
      owner: this.store.get<'human' | 'agent'>(`desktop:${this.definition.id}:owner`, 'agent'),
      epoch: this.store.get(`desktop:${this.definition.id}:epoch`, 0),
      supported:
        c?.mode === 'vnc' ||
        (process.platform === 'linux' && !!Bun.which('xdotool') && !!Bun.which('import')),
      note:
        c?.mode === 'vnc'
          ? 'VNC desktop; remote hosts use a loopback SSH tunnel.'
          : 'Linux X11; VNC must share the configured DISPLAY.',
    };
  }
  target() {
    const current = this.config.read().desktops.find((d) => d.id === this.definition.id);
    if (
      this.closed ||
      !current ||
      connectionIdentity(current) !== connectionIdentity(this.definition)
    )
      return undefined;
    return this.definition.connection
      ? { ...this.definition.connection, revision: this.definition.revision }
      : this.host?.target;
  }
  environment(actor: 'human' | 'agent') {
    if (this.closed) throw new Error('Desktop closed.');
    if (actor === 'agent') this.requireAgent();
    const target = this.target();
    if (!target) throw new Error('Prepare the desktop before opening its shell.');
    if (this.definition.kind === 'external' && target.mode === 'vnc') return shellEnvironment();
    const env: Record<string, string> = {
      ...shellEnvironment(),
      ...this.host?.environment,
      DISPLAY: target.display,
    };
    if (this.host?.source === 'virtual') delete env.WAYLAND_DISPLAY;
    return env;
  }
  credential() {
    const c = this.definition.connection;
    return c
      ? this.vault.get(`desktop:${this.definition.id}`, this.definition.revision)
      : this.host?.password;
  }
  async prepare() {
    this.store.assertEnabled();
    if (this.closed) throw new Error('Desktop closed.');
    if (this.target()) return this.status();
    if (!this.host) throw new Error('Automatic desktop is unavailable.');
    await this.host.prepare(this.definition.kind === 'virtual');
    return this.status();
  }
  async launch(app: 'browser' | 'terminal', url?: string, actor: 'agent' | 'human' = 'agent') {
    await this.prepare();
    if (actor === 'agent') this.requireAgent();
    if (this.definition.connection)
      throw new Error('アプリの起動は自動接続したデスクトップで利用できます。');
    return this.host!.launch(app, url);
  }
  async preview() {
    this.store.assertEnabled();
    if (this.closed) throw new Error('Desktop closed.');
    const c = this.target(),
      epoch = this.status().epoch;
    if (!c) throw new Error('Desktop is not ready.');
    // A separate connection cannot mutate or consume the agent's observation.
    const client = new RfbClient(c.vncHost, c.vncPort, () => {
      this.store.assertEnabled();
      if (this.closed) throw new Error('Desktop closed.');
      if (epoch !== this.status().epoch || c.revision !== this.target()?.revision)
        throw new Error('Desktop changed.');
    });
    this.previews.add(client);
    try {
      await client.connect(this.credential());
      const buffer = await client.screenshot();
      return { image: buffer.toString('base64') };
    } finally {
      this.previews.delete(client);
      client.close();
    }
  }
  handoff(owner: 'human' | 'agent') {
    this.observation = undefined;
    this.store.set(
      `desktop:${this.definition.id}:epoch`,
      this.store.get(`desktop:${this.definition.id}:epoch`, 0) + 1,
    );
    this.store.set(`desktop:${this.definition.id}:owner`, owner);
    return this.status();
  }
  private requireAgent() {
    this.store.assertEnabled();
    if (this.closed) throw new Error('Desktop closed.');
    const c = this.target();
    if (!c || !this.status().supported)
      throw new Error(
        'Configure a Linux X11 desktop with xdotool, ImageMagick and an authenticated VNC server.',
      );
    if (this.status().owner === 'human')
      throw new Error('User owns this desktop. AI observation and input are suspended.');
    return c;
  }
  async screenshot() {
    if (!this.target()) await this.prepare();
    const c = this.requireAgent(),
      epoch = this.status().epoch;
    if (c.mode === 'vnc') {
      const client = await this.vnc();
      try {
        const buffer = await client.screenshot();
        if (buffer.length > 4 * 1024 * 1024) throw new Error('Desktop capture exceeds 4 MiB.');
        this.requireAgent();
        this.observation = {
          id: crypto.randomUUID(),
          epoch,
          revision: c.revision,
          width: client.width,
          height: client.height,
        };
        return {
          ...this.observation,
          image: { type: 'image' as const, mimeType: 'image/png', data: buffer.toString('base64') },
        };
      } finally {
        this.releaseVnc(client);
      }
    }
    const proc = Bun.spawn(['import', '-display', c.display, '-window', 'root', 'png:-'], {
      env: shellEnvironment(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
    });
    this.processes.add(proc);
    const [data, error, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    this.processes.delete(proc);
    this.requireAgent();
    if (epoch !== this.status().epoch || c.revision !== this.target()?.revision)
      throw new Error('Desktop changed during capture. Observe it again.');
    const buffer = Buffer.from(data);
    if (
      code !== 0 ||
      buffer.length < 24 ||
      buffer.length > 4 * 1024 * 1024 ||
      buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a'
    )
      throw new Error('Desktop capture failed or exceeds 4 MiB.');
    this.observation = {
      id: crypto.randomUUID(),
      epoch,
      revision: c.revision,
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
    return {
      ...this.observation,
      image: { type: 'image' as const, mimeType: 'image/png', data: buffer.toString('base64') },
    };
  }
  async input(input: {
    observationId: string;
    action: 'click' | 'type' | 'key' | 'scroll' | 'drag';
    x?: number;
    y?: number;
    toX?: number;
    toY?: number;
    text?: string;
    key?: string;
    direction?: 'up' | 'down';
  }) {
    const c = this.requireAgent(),
      observation = this.observation;
    if (
      !observation ||
      observation.id !== input.observationId ||
      observation.epoch !== this.status().epoch ||
      observation.revision !== c.revision
    )
      throw new Error('A fresh screenshot is required before desktop input.');
    const point = (x?: number, y?: number) => {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x! < 0 ||
        y! < 0 ||
        x! >= observation.width ||
        y! >= observation.height
      )
        throw new Error('Coordinates are outside the captured display.');
      return [String(x), String(y)];
    };
    if (c.mode === 'vnc') {
      // Validate the complete operation before sending its first side effect.
      if (input.action === 'click' || input.action === 'drag') point(input.x, input.y);
      if (input.action === 'drag') point(input.toX, input.toY);
      if (input.action === 'type' && (!input.text || input.text.length > 10000))
        throw new Error('Text is required (up to 10000 characters).');
      const client = await this.vnc();
      try {
        if (client.width !== observation.width || client.height !== observation.height)
          throw new Error('Display size changed; capture again.');
        this.observation = undefined;
        switch (input.action) {
          case 'click':
            client.pointer(input.x!, input.y!, 1);
            client.pointer(input.x!, input.y!, 0);
            break;
          case 'drag':
            client.pointer(input.x!, input.y!, 1);
            client.pointer(input.toX!, input.toY!, 1);
            client.pointer(input.toX!, input.toY!, 0);
            break;
          case 'type':
            client.text(input.text!);
            break;
          case 'key':
            client.chord(input.key || '');
            break;
          case 'scroll':
            client.pointer(input.x || 0, input.y || 0, input.direction === 'up' ? 8 : 16);
            client.pointer(input.x || 0, input.y || 0);
            break;
        }
        await client.drain();
        return { executed: true, requiresObservation: true };
      } finally {
        this.releaseVnc(client);
      }
    }
    let args: string[];
    switch (input.action) {
      case 'click':
        args = ['mousemove', '--sync', ...point(input.x, input.y), 'click', '1'];
        break;
      case 'type':
        if (!input.text || input.text.length > 10000)
          throw new Error('Text is required (up to 10000 characters).');
        args = ['type', '--clearmodifiers', '--', input.text];
        break;
      case 'key':
        if (!input.key || !/^[a-zA-Z0-9_+ -]{1,100}$/.test(input.key))
          throw new Error('Invalid key.');
        args = ['key', '--clearmodifiers', input.key];
        break;
      case 'scroll':
        args = ['click', input.direction === 'up' ? '4' : '5'];
        break;
      case 'drag':
        args = [
          'mousemove',
          '--sync',
          ...point(input.x, input.y),
          'mousedown',
          '1',
          'mousemove',
          '--sync',
          ...point(input.toX, input.toY),
          'mouseup',
          '1',
        ];
        break;
    }
    this.observation = undefined;
    const proc = Bun.spawn(['xdotool', ...args], {
      env: { ...shellEnvironment(), DISPLAY: c.display },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
    });
    this.processes.add(proc);
    const [, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    this.processes.delete(proc);
    if (code !== 0) throw new Error('Desktop input failed; observe before retrying.');
    return { executed: true, requiresObservation: true };
  }
  private async vnc() {
    const c = this.requireAgent(),
      epoch = this.status().epoch;
    if (this.vncBusy)
      throw new Error('Another desktop operation is in progress. Observe again after it finishes.');
    this.vncBusy = true;
    const cached = this.cachedVnc;
    if (
      cached &&
      !cached.client.closed &&
      cached.epoch === epoch &&
      cached.revision === c.revision
    ) {
      cached.client.begin();
      return cached.client;
    }
    if (cached) {
      this.sessions.delete(cached.client);
      cached.client.close();
    }
    const client = new RfbClient(c.vncHost, c.vncPort, () => {
      this.requireAgent();
      if (this.status().epoch !== epoch || this.target()?.revision !== c.revision)
        throw new Error('Desktop changed.');
    });
    this.sessions.add(client);
    try {
      await client.connect(this.credential());
      this.cachedVnc = { client, epoch, revision: c.revision };
      return client;
    } catch (error) {
      this.vncBusy = false;
      this.sessions.delete(client);
      client.close();
      throw error;
    }
  }
  private releaseVnc(client: RfbClient) {
    client.idle();
    this.vncBusy = false;
  }
  async verifyCredential(revision: number) {
    const c = this.target();
    if (!c || c.revision !== revision)
      return { status: 'stale', message: '画面の接続設定が変更されました。' };
    const client = new RfbClient(c.vncHost, c.vncPort);
    try {
      await client.connect(this.vault.get(`desktop:${this.definition.id}`, revision));
      return { status: 'verified', message: 'VNCの認証を確認しました。' };
    } catch (error) {
      const invalid =
        error instanceof Error &&
        /authentication rejected|password is required/.test(error.message);
      return {
        status: invalid ? 'invalid' : 'temporary_error',
        message: invalid
          ? 'VNCパスワードを確認して再入力してください。'
          : 'VNCに接続できません。接続先を確認して再試行してください。',
      };
    } finally {
      client.close();
    }
  }
  async close() {
    this.closed = true;
    this.handoff(this.status().owner);
    this.store.changes.off('change', this.changed);
    for (const c of this.previews) c.close();
    for (const c of this.sessions) c.close();
    for (const p of this.processes) p.kill();
    await this.host?.close();
  }
}

/** Registry owns each display's independent lifecycle and control lease. */
export class Desktop {
  private sessions = new Map<string, DesktopSession>();
  private changing = new Set<string>();
  private retiring = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly vault: Vault,
    readonly options: { home: string; directory: string },
  ) {
    // Upgrade the singleton once, retaining its identity, credentials and manual ownership.
    if (!store.get('desktopRegistryVersion', 0)) {
      const first = config.read().desktops.find((d) => d.id === 'default');
      if (first) {
        store.set('desktop:default:owner', store.get('desktopOwner', 'agent'));
        store.set('desktop:default:epoch', store.get('desktopEpoch', 0));
        const secret = vault.get('desktop', first.revision);
        if (secret && !vault.get('desktop:default', first.revision))
          vault.put('desktop:default', first.revision, crypto.randomUUID(), secret);
        for (const request of store.db.select().from(requests).all())
          if (request.spec.targetId === 'desktop')
            store.db
              .update(requests)
              .set({ spec: { ...request.spec, targetId: 'desktop:default' } })
              .where(eq(requests.id, request.id))
              .run();
      }
      store.db
        .delete(state)
        .where(inArray(state.key, ['desktopOwner', 'desktopEpoch']))
        .run();
      store.set('desktopRegistryVersion', 1);
    }
    try {
      const raw = JSON.parse(readFileSync(config.path, 'utf8'));
      if (!raw.desktops) config.update(config.read().revision, () => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private session(id?: string) {
    if (this.closed) throw new Error('Desktops closed.');
    const definitions = this.config.read().desktops;
    const definition = definitions.find((d) => d.id === (id || definitions[0].id));
    if (!definition) throw new Error('Desktop not found.');
    let value = this.sessions.get(definition.id);
    if (
      value &&
      connectionIdentity(value.definition) !== connectionIdentity(definition) &&
      !this.changing.has(definition.id)
    ) {
      this.changing.add(definition.id);
      const previous = value;
      const closing = previous.close().finally(() => {
        this.sessions.delete(definition.id);
        this.changing.delete(definition.id);
        this.retiring.delete(definition.id);
        if (!this.closed) this.store.notify();
      });
      this.retiring.set(definition.id, closing);
      void closing.catch(() => {});
    }
    if (value) value.definition.name = definition.name;
    if (!value) {
      value = new DesktopSession(this.store, this.config, this.vault, definition, this.options);
      this.sessions.set(definition.id, value);
    }
    return value;
  }
  get(id?: string) {
    const value = this.session(id);
    if (this.changing.has(value.definition.id))
      throw new Error('Desktop configuration is changing. Retry after it finishes.');
    return value;
  }
  list() {
    return this.config.read().desktops.map((d) => ({
      ...this.session(d.id).status(),
      ...(this.changing.has(d.id) ? { configured: false, setup: 'preparing' as const } : {}),
    }));
  }
  private assertUnused(id: string) {
    if (
      this.store.db
        .select()
        .from(runs)
        .all()
        .some((r) => r.desktopId === id && ['running', 'stopping'].includes(r.state))
    )
      throw new Error('このデスクトップのシェルを停止してから変更・削除してください。');
  }
  create(name: string, kind: 'virtual' | 'external' = 'virtual', connection?: unknown) {
    this.store.assertEnabled();
    const definition = desktopDefinitionSchema.parse({
      id: crypto.randomUUID(),
      name,
      kind,
      connection,
    });
    this.config.update(this.config.read().revision, (c) => {
      if (c.desktops.length >= 16) throw new Error('デスクトップは16個まで作成できます。');
      if (
        definition.connection &&
        c.desktops.some((d) => d.connection?.vncPort === definition.connection!.vncPort)
      )
        throw new Error('この画面は登録済みです。');
      c.desktops.push({ ...definition, revision: 1 });
    });
    this.store.notify();
    return this.get(definition.id).status();
  }
  async update(revision: number, raw: unknown) {
    this.store.assertEnabled();
    const definition = desktopDefinitionSchema.parse(raw);
    const previous = this.config.read();
    if (previous.revision !== revision)
      throw new Error('Configuration changed. Reload before saving.');
    const old = previous.desktops.find((d) => d.id === definition.id);
    if (!old) throw new Error('Desktop not found.');
    if (
      definition.connection &&
      previous.desktops.some(
        (d) => d.id !== definition.id && d.connection?.vncPort === definition.connection!.vncPort,
      )
    )
      throw new Error('この画面は登録済みです。');
    const targetChanged =
      connectionIdentity(old) !== connectionIdentity({ ...definition, revision: old.revision });
    if (!targetChanged) {
      this.config.update(revision, (c) => {
        c.desktops = c.desktops.map((d) =>
          d.id === definition.id ? { ...d, name: definition.name } : d,
        );
      });
      // The descriptor name is nonsecret and does not invalidate observation or credentials.
      this.session(definition.id).definition.name = definition.name;
      this.store.notify();
      return this.get(definition.id).status();
    }
    this.assertUnused(definition.id);
    this.get(definition.id);
    this.changing.add(definition.id);
    try {
      await this.sessions.get(definition.id)?.close();
      this.config.update(revision, (c) => {
        c.desktops = c.desktops.map((d) =>
          d.id === definition.id ? { ...definition, revision: d.revision + 1 } : d,
        );
      });
    } finally {
      this.sessions.delete(definition.id);
      this.changing.delete(definition.id);
      this.store.notify();
    }
    return this.get(definition.id).status();
  }
  async remove(id: string, actor: 'human' | 'agent' = 'human') {
    this.store.assertEnabled();
    const session = this.get(id);
    if (actor === 'agent' && session.status().owner === 'human')
      throw new Error('User owns this desktop.');
    this.assertUnused(id);
    const config = this.config.read();
    if (config.desktops.length === 1) throw new Error('最後のデスクトップは削除できません。');
    if (config.mcp.some((m) => m.targetId === `desktop:${id}`))
      throw new Error('このデスクトップのMCP接続を解除してから削除してください。');
    this.changing.add(id);
    try {
      await session.close();
      this.config.update(config.revision, (c) => {
        c.desktops = c.desktops.filter((d) => d.id !== id);
      });
    } finally {
      this.sessions.delete(id);
      this.changing.delete(id);
      this.store.notify();
    }
  }
  async close() {
    this.closed = true;
    await Promise.all([
      ...this.retiring.values(),
      ...[...this.sessions.values()]
        .filter((s) => !this.retiring.has(s.definition.id))
        .map((session) => session.close()),
    ]);
    this.sessions.clear();
  }
}
