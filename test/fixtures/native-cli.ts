import { createInterface } from 'node:readline';

if (process.argv.includes('app-server')) {
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'fixture' } });
    if (request.method === 'account/read')
      send({ id: request.id, result: { account: null, requiresOpenaiAuth: false } });
    if (request.method === 'thread/start' || request.method === 'thread/resume')
      send({
        id: request.id,
        result: { thread: { id: request.params.threadId || 'native-thread' } },
      });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'native-turn', status: 'inProgress' } } });
      if (request.params.input[0].text === 'wait') return;
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'native-thread', delta: 'native response' },
      });
      send({
        method: 'turn/completed',
        params: {
          threadId: 'native-thread',
          turn: { id: 'native-turn', status: 'completed', error: null },
        },
      });
    }
  });
} else {
  const input = await Bun.stdin.text();
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'claude-session',
      result: input,
      total_cost_usd: 0,
    }),
  );
}
