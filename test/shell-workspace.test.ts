import { expect, test } from 'bun:test';
import { fixture, eventually } from './helpers';
import { createHttp } from '../src/server/http';
import { runs } from '../src/server/db/schema';

const headers = {
  Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
  'X-Vibe-Coder': '1',
  'Content-Type': 'application/json',
};

test('shared shell supports streaming JSON stdin, bounded waits, EOF and process exit without interpreting turns', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const run = r.runs.start(r.id, {
      mode: 'pipe',
      command: `python3 -u -c 'import sys,json\nfor line in sys.stdin: print(json.dumps({"echo":json.loads(line)}),flush=True)'`,
    });
    expect(r.runs.read(run.id).capabilities.immediateInput).toBe(true);
    const waiting = r.runs.wait(run.id);
    r.runs.write(run.id, '{"text":"日本語"}\n', 'agent', run.epoch);
    const first = await waiting;
    expect(JSON.parse(first.text)).toEqual({ echo: { text: '日本語' } });
    expect(first.state).toBe('running');
    expect(first.turnState).toBe('unknown');
    r.runs.write(run.id, '{"text":"second"}\n', 'agent', run.epoch);
    expect((await r.runs.wait(run.id, first.nextOffset)).text).toContain('second');
    r.runs.endInput(run.id, 'agent', run.epoch);
    expect(() => r.runs.write(run.id, 'not sent', 'agent', run.epoch)).toThrow();
    await eventually(() => r.runs.get(run.id).state === 'completed');
    expect(r.runs.get(run.id).exitCode).toBe(0);
    expect(r.runs.output.listenerCount(run.id)).toBe(0);
    expect(r.agent.tools(r.id).map((t) => t.name)).toContain('run_write');
    expect(r.agent.tools(r.id).map((t) => t.name)).not.toContain('native_start');
  } finally {
    await r.dispose();
  }
});

test('pipe ownership revokes waits and stale inputs; private ended output cannot be returned to the agent', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const run = r.runs.start(r.id, { command: 'cat' });
    const waiting = r.runs.wait(run.id).then(
      () => false,
      () => true,
    );
    const human = r.runs.handoff(run.id, 'human');
    expect(await waiting).toBe(true);
    expect(() => r.runs.write(run.id, 'wrong', 'agent', run.epoch)).toThrow();
    expect(() => r.runs.endInput(run.id, 'agent', run.epoch)).toThrow();
    r.runs.write(run.id, 'PRIVATE_HUMAN_INTERVAL\n', 'human', human.epoch);
    await eventually(() => r.runs.read(run.id).text.includes('PRIVATE_HUMAN_INTERVAL'));
    r.runs.endInput(run.id, 'human', human.epoch);
    await eventually(() => r.runs.get(run.id).state === 'completed');
    expect(r.runs.read(run.id).text).toContain('PRIVATE_HUMAN_INTERVAL');
    expect(r.runs.get(run.id).output).not.toContain('PRIVATE_HUMAN_INTERVAL');
    r.runs.handoff(run.id, 'agent');
    expect(r.runs.read(run.id, 0, 32000, true).text).not.toContain('PRIVATE_HUMAN_INTERVAL');
  } finally {
    await r.dispose();
  }
});

test('decks persist membership and visibility, reject stale changes and do not terminate hidden or moved runs', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const initial = r.store.workspace(r.id);
    r.store.updateWorkspace(r.id, {
      ...initial,
      decks: [...initial.decks, { id: 'build', name: 'Build' }],
    });
    const run = r.runs.start(r.id, { mode: 'pty', deckId: 'build', title: 'dev server' });
    const workspace = r.store.workspace(r.id);
    expect(workspace.placements[run.id]).toBe('build');
    const hidden = r.store.updateWorkspace(r.id, { ...workspace, hidden: [run.id] });
    expect(r.runs.get(run.id).state).toBe('running');
    expect(r.store.snapshot(r.id).workspace.hidden).toEqual([run.id]);
    expect(() => r.store.updateWorkspace(r.id, workspace)).toThrow('更新');
    expect(() =>
      r.store.updateWorkspace(r.id, { ...hidden, placements: { fake: 'build' } }),
    ).toThrow();
    expect(() => r.runs.start(r.id, { mode: 'pty', deckId: 'missing' })).toThrow();
    expect(r.store.snapshot(r.id).runs.length).toBe(1);
    const other = r.store.createConversation();
    expect(r.store.workspace(other.id).placements).toEqual({});
    r.runs.write(run.id, 'printf "__HIDDEN_ACTIVE__\\n"\n', 'agent', run.epoch);
    await eventually(() => r.runs.read(run.id).text.includes('__HIDDEN_ACTIVE__'));
  } finally {
    await r.dispose();
  }
});

test('a full workspace rejects launch before creating a process', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    const placements: Record<string, string> = {};
    r.store.db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const id = crypto.randomUUID();
        placements[id] = 'main';
        r.store.db
          .insert(runs)
          .values({
            id,
            conversationId: r.id,
            kind: 'shell',
            title: 'archived',
            cwd: r.home,
            host: 'test',
            state: 'completed',
            createdAt: Date.now(),
          })
          .run();
      }
    });
    r.store.updateWorkspace(r.id, { ...r.store.workspace(r.id), placements });
    expect(() => r.runs.start(r.id, { command: 'cat', deckId: 'main' })).toThrow();
    expect(r.store.snapshot(r.id).runs.length).toBe(2000);
  } finally {
    await r.dispose();
  }
});

test('HTTP and parent agent share process start/input/EOF; native launch routes are removed', async () => {
  const r = await fixture();
  const { app } = createHttp(r);
  try {
    r.agent.pause(r.id, true);
    const response = await app.request('/api/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversationId: r.id,
        spec: { mode: 'pipe', command: 'cat', title: 'HTTP pipe' },
      }),
    });
    expect(response.status).toBe(201);
    const run = (await response.json()) as { id: string; epoch: number; owner: string };
    expect(run.owner).toBe('human');
    const write = await app.request(`/api/runs/${run.id}/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'http input\n', epoch: run.epoch }),
    });
    expect(write.status).toBe(200);
    await eventually(() => r.runs.read(run.id).text.includes('http input'));
    const end = await app.request(`/api/runs/${run.id}/end-input`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ epoch: run.epoch }),
    });
    expect(end.status).toBe(200);
    await eventually(() => r.runs.get(run.id).state === 'completed');
    expect((await app.request('/api/native', { method: 'POST', headers, body: '{}' })).status).toBe(
      404,
    );
    const tool = (name: string) => r.agent.tools(r.id).find((t) => t.name === name)!;
    const child = (await tool('shell_exec').execute({ command: 'cat', mode: 'pipe' })) as {
      id: string;
      epoch: number;
    };
    await tool('run_write').execute({ id: child.id, epoch: child.epoch, text: 'agent input\n' });
    expect(((await tool('run_wait').execute({ id: child.id })) as { text: string }).text).toContain(
      'agent input',
    );
    await tool('run_end_input').execute(child);
    await eventually(() => r.runs.get(child.id).state === 'completed');
  } finally {
    await r.dispose();
  }
});

test('agent PTY answers terminal reports without a browser and all-stop ends the shared process', async () => {
  const r = await fixture();
  try {
    r.agent.pause(r.id, true);
    await Bun.write(
      `${r.home}/query.py`,
      `import os,sys,tty,select\ntty.setraw(sys.stdin.fileno())\nsys.stdout.write('\\x1b[6n\\x1b]11;?\\x07');sys.stdout.flush()\ndata=b''\nwhile b'R' not in data or b'rgb:' not in data:\n if not select.select([sys.stdin],[],[],3)[0]: sys.exit(2)\n data+=os.read(sys.stdin.fileno(),1024)\nsys.stdout.write('REPORTS_OK\\r\\n');sys.stdout.flush()\n`,
    );
    const run = r.runs.start(r.id, { command: 'python3 query.py', mode: 'pty' });
    await eventually(() => !['running', 'stopping'].includes(r.runs.get(run.id).state), 5000);
    expect(r.runs.get(run.id).exitCode).toBe(0);
    expect(r.runs.read(run.id).text).toContain('REPORTS_OK');
    const waiting = r.runs.start(r.id, { command: 'cat' });
    r.agent.stopAll();
    await eventually(() => r.runs.get(waiting.id).state === 'failed');
    expect(() => r.runs.start(r.id, { mode: 'pty' })).toThrow();
  } finally {
    await r.dispose();
  }
});
