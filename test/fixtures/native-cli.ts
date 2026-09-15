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
    if (request.method === 'turn/steer') {
      if (request.params.expectedTurnId !== 'native-turn')
        send({ id: request.id, error: { message: 'stale' } });
      else {
        send({ id: request.id, result: { turnId: 'native-turn' } });
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'native-thread', delta: request.params.input[0].text },
        });
        setTimeout(
          () =>
            send({
              method: 'turn/completed',
              params: {
                threadId: 'native-thread',
                turn: { id: 'native-turn', status: 'completed' },
              },
            }),
          40,
        );
      }
    }
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
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      if (message.request.subtype === 'interrupt')
        send({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'claude-session',
        });
      send({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      });
    }
    if (message.type === 'user') {
      send({ type: 'system', subtype: 'init', session_id: 'claude-session' });
      send(message);
      if (message.message.content === 'wait') return;
      setTimeout(
        () =>
          send({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 'claude-session',
            result: message.message.content,
            total_cost_usd: 0,
          }),
        60,
      );
    }
  });
}
