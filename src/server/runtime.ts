import { join } from 'node:path';
import { WorkspaceChanges } from './changes';
import { eq } from 'drizzle-orm';
import { openDatabase } from './db';
import { schedules } from './db/schema';
import { Config, Vault, loadHome, stateDirectory } from './config';
import { Store } from './store';
import { HumanService } from './human';
import { RunService } from './runs';
import { MemoryService } from './memory';
import { Scheduler } from './scheduler';
import { Files } from './files';
import { ChatModel, type ModelAdapter } from './model';
import { McpService } from './mcp';
import { McpInstaller } from './mcp-install';
import { Desktop } from './desktop';
import { Agent } from './agent';
import { verifyProvider } from './credentials';
import { prune } from './retention';
import { NativeService } from './native';
import { CodexAuth } from './codex-auth';
import { CodexModel } from './codex-model';

export function createRuntime(options: {
  home: string;
  directory?: string;
  config?: Config;
  model?: ModelAdapter;
  codex?: { command?: string[]; credentialFile?: string; fetch?: typeof fetch };
  timers?: boolean;
}) {
  const { home, repo } = loadHome(options.home);
  const directory = options.directory || stateDirectory(home),
    config = options.config || new Config(),
    vault = new Vault(config.directory);
  const { db, sqlite } = openDatabase(join(directory, 'state.sqlite'));
  const store = new Store(db),
    human = new HumanService(store, config, vault),
    runs = new RunService(store, home, vault);
  const memory = new MemoryService(join(directory, 'memory.sqlite')),
    changes = new WorkspaceChanges(home, directory),
    files = new Files(home),
    scheduler = new Scheduler(store, runs);
  const mcp = new McpService(store, config, vault, runs, human, home),
    desktop = new Desktop(store, config, vault, { home, directory });
  const mcpInstaller = new McpInstaller(mcp);
  let workspaceReady = false;
  void changes.ready
    .then(() => {
      workspaceReady = true;
    })
    .catch(() => {});
  human.verifyCredential = async (target, revision, conversationId) => {
    if (target.startsWith('mcp:') || target.startsWith('oauth-client:')) {
      const name = target.slice(target.indexOf(':') + 1);
      if (config.targetVersion(target) !== revision)
        return { status: 'unverified', message: '接続設定が変更されました。' };
      mcp.connectRun(conversationId, name);
      return {
        status: 'unverified',
        message: '認証情報を保存し、接続確認を開始しました。設定のMCP接続で結果を確認できます。',
      };
    }
    return target === 'provider:main'
      ? verifyProvider(config, vault, revision)
      : target === 'desktop'
        ? desktop.verifyCredential(revision)
        : { status: 'unverified', message: '資格情報を保存しました。接続操作で確認できます。' };
  };
  const codex = new CodexAuth(
    store,
    human,
    desktop,
    home,
    options.codex?.command,
    options.codex?.credentialFile,
  );
  const native = new NativeService(
    store,
    runs,
    human,
    { codex: codex.command, claude: ['claude'] },
    codex,
  );
  const apiModel = new ChatModel(config, vault),
    subscriptionModel = new CodexModel(config, codex, options.codex?.fetch);
  const model: ModelAdapter = options.model || {
    isConfigured: () => {
      const provider = config.read().provider;
      return (
        !!provider &&
        (provider.kind === 'codex' ||
          !provider.keyRequired ||
          !!vault.get('provider:main', provider.revision))
      );
    },
    call: (input) =>
      (config.read().provider?.kind === 'codex' ? subscriptionModel : apiModel).call(input),
  };
  const agent = new Agent(
    store,
    config,
    vault,
    model,
    memory,
    files,
    runs,
    human,
    scheduler,
    mcp,
    desktop,
    native,
    codex,
  );
  agent.beforeWork = () => changes.ready;
  native.beforeWork = () => changes.ready;
  runs.recover();
  human.recover();
  codex.recover();
  agent.recover();
  const conversation = store.listConversations()[0] || store.createConversation();
  const syncRoutines = () => {
    const { repo } = loadHome(home);
    const wanted = new Set(repo.routines.map((r) => `routine:${r.id}`));
    for (const s of db.select().from(schedules).where(eq(schedules.source, 'repo')).all())
      if (!wanted.has(s.id)) db.delete(schedules).where(eq(schedules.id, s.id)).run();
    for (const r of repo.routines) {
      const id = `routine:${r.id}`,
        factor = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[r.every.slice(-1)]!;
      const intervalMs = Number(r.every.slice(0, -1)) * factor;
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
        throw new Error('Routine intervals must be at least one second.');
      const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
      if (!existing && !store.stopped)
        scheduler.create(
          conversation.id,
          {
            title: r.id,
            prompt: r.text,
            action: r.action,
            nextAt: Date.now() + intervalMs,
            intervalMs,
          },
          id,
          'repo',
        );
      else if (
        existing &&
        (existing.prompt !== r.text ||
          existing.intervalMs !== intervalMs ||
          existing.action !== r.action)
      )
        db.update(schedules)
          .set({ prompt: r.text, intervalMs, action: r.action })
          .where(eq(schedules.id, id))
          .run();
    }
  };
  syncRoutines();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.timers !== false) {
    timer = setInterval(() => {
      try {
        human.recover();
        syncRoutines();
        if (workspaceReady) scheduler.tick();
        if (Date.now() - store.get('lastPrune', { at: 0 }).at >= 3600000) prune(store, config);
      } catch {
        /* Invalid edited configuration is exposed by doctor/model input; keep forms alive. */
      }
    }, 1000);
    if (!store.stopped && !config.read().desktop) void desktop.prepare().catch(() => {});
    if (!store.stopped)
      for (const c of config.read().mcp.filter((c) => c.enabled))
        void mcp.connect(c).catch(() => {});
  }
  store.notify();
  if (config.read().provider?.kind === 'codex' && !store.stopped)
    void codex.refresh().catch(() => {});
  return {
    home,
    directory,
    config,
    vault,
    store,
    human,
    runs,
    memory,
    files,
    changes,
    scheduler,
    mcp,
    mcpInstaller,
    desktop,
    agent,
    native,
    codex,
    model,
    async close() {
      clearInterval(timer);
      await changes.ready.catch(() => {});
      await codex.close();
      human.shutdown();
      await agent.close();
      runs.stopAll();
      await mcp.close();
      await desktop.close();
      await runs.close();
      memory.close();
      sqlite.close();
    },
  };
}
export type Runtime = ReturnType<typeof createRuntime>;
