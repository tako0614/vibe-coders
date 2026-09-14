import { Config, Vault } from './config';
import { Store } from './store';
import { shellEnvironment } from './runs';
import { RfbClient } from './rfb';

export class Desktop {
  private sessions = new Set<RfbClient>();
  private cachedVnc?: { client: RfbClient; epoch: number; revision: number };
  private vncBusy = false;
  private processes = new Set<{ kill: () => void }>();
  private changed = () => {
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
  ) {
    store.changes.on('change', this.changed);
  }
  status() {
    const c = this.config.read().desktop;
    return {
      configured: !!c,
      name: c?.name,
      display: c?.display,
      host: 'backend host',
      owner: this.store.get<'human' | 'agent'>('desktopOwner', 'agent'),
      epoch: this.store.get('desktopEpoch', 0),
      supported:
        c?.mode === 'vnc' ||
        (process.platform === 'linux' && !!Bun.which('xdotool') && !!Bun.which('import')),
      note:
        c?.mode === 'vnc'
          ? 'VNC desktop; remote hosts use a loopback SSH tunnel.'
          : 'Linux X11; VNC must share the configured DISPLAY.',
    };
  }
  handoff(owner: 'human' | 'agent') {
    this.observation = undefined;
    this.store.set('desktopEpoch', this.store.get('desktopEpoch', 0) + 1);
    this.store.set('desktopOwner', owner);
    return this.status();
  }
  private requireAgent() {
    this.store.assertEnabled();
    const c = this.config.read().desktop;
    if (!c || !this.status().supported)
      throw new Error(
        'Configure a Linux X11 desktop with xdotool, ImageMagick and an authenticated VNC server.',
      );
    if (this.status().owner === 'human')
      throw new Error('User owns this desktop. AI observation and input are suspended.');
    return c;
  }
  async screenshot() {
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
    if (epoch !== this.status().epoch || c.revision !== this.config.read().desktop?.revision)
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
      if (this.status().epoch !== epoch || this.config.read().desktop?.revision !== c.revision)
        throw new Error('Desktop changed.');
    });
    this.sessions.add(client);
    try {
      await client.connect(this.vault.get('desktop', c.revision));
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
    const c = this.config.read().desktop;
    if (!c || c.revision !== revision)
      return { status: 'stale', message: '画面の接続設定が変更されました。' };
    const client = new RfbClient(c.vncHost, c.vncPort);
    try {
      await client.connect(this.vault.get('desktop', revision));
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
  close() {
    this.store.changes.off('change', this.changed);
    for (const c of this.sessions) c.close();
    for (const p of this.processes) p.kill();
  }
}
