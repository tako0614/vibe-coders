import { join } from 'node:path';
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
    files = new Files(home),
    scheduler = new Scheduler(store, runs);
  const mcp = new McpService(store, config, vault, runs, human, home),
    desktop = new Desktop(store, config, vault);
  human.verifyCredential = async (target, revision) =>
    target === 'provider:main'
      ? verifyProvider(config, vault, revision)
      : target === 'desktop'
        ? desktop.verifyCredential(revision)
        : { status: 'unverified', message: '資格情報を保存しました。接続操作で確認できます。' };
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
        scheduler.tick();
        if (Date.now() - store.get('lastPrune', { at: 0 }).at >= 3600000) prune(store, config);
      } catch {
        /* Invalid edited configuration is exposed by doctor/model input; keep forms alive. */
      }
    }, 1000);
    if (!store.stopped)
      for (const c of config.read().mcp.filter((c) => c.enabled))
        void mcp.connect(c).catch(() => {});
  }
  store.notify();
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
    scheduler,
    mcp,
    desktop,
    agent,
    native,
    codex,
    model,
    async close() {
      clearInterval(timer);
      await codex.close();
      human.shutdown();
      await agent.close();
      runs.stopAll();
      await mcp.close();
      desktop.close();
      await runs.close();
      memory.close();
      sqlite.close();
    },
  };
}
export type Runtime = ReturnType<typeof createRuntime>;
