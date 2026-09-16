// JSON-RPC authentication fixture; never reads or changes the host Codex account.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
const stateFile = process.argv[2];
const credentialFile = process.argv[3];
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const state = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
};
let loginId = '',
  delivered = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  appendFileSync(
    `${stateFile}.calls`,
    `${JSON.stringify({ method: req.method, input: req.params?.input })}\n`,
  );
  const reply = (result: unknown) => send({ id: req.id, result });
  if (req.method === 'initialize') reply({ userAgent: 'auth-fixture' });
  if (req.method === 'model/list')
    reply({
      data: [
        {
          id: 'fixture',
          model: 'subscription-model',
          displayName: 'Subscription fixture',
          isDefault: true,
          hidden: false,
        },
      ],
      nextCursor: null,
    });
  if (req.method === 'account/read') {
    if (credentialFile && isAbsolute(credentialFile) && state().signedIn)
      writeFileSync(
        credentialFile,
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.private-fixture-token`,
            account_id: 'fixture-account',
          },
        }),
      );
    reply({
      account: state().signedIn
        ? { type: 'chatgpt', email: 'private-account@example.invalid', planType: 'plus' }
        : null,
      requiresOpenaiAuth: true,
    });
  }
  if (req.method === 'account/login/start') {
    loginId = `fixture-login-${process.pid}`;
    process.stderr.write('private-stderr-auth-marker\n');
    reply({
      type: req.params.type,
      loginId,
      ...(req.params.type === 'chatgptDeviceCode'
        ? {
            verificationUrl: state().invalidUrl
              ? 'https://hostile.example/login'
              : 'https://auth.openai.com/codex/device',
            userCode: 'PRIVATE-CODE-234',
          }
        : { authUrl: 'https://auth.openai.com/authorize?state=private-auth-url-marker' }),
    });
  }
  if (req.method === 'account/login/cancel') {
    loginId = '';
    reply({ status: 'canceled' });
  }
  if (req.method === 'thread/start' || req.method === 'thread/resume')
    reply({ thread: { id: req.params.threadId || 'auth-thread' } });
  if (req.method === 'turn/start') {
    reply({ turn: { id: 'auth-turn', status: 'inProgress' } });
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'auth-thread', delta: 'resumed after login' },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'auth-thread',
        turn: { id: 'auth-turn', status: 'completed', error: null },
      },
    });
  }
});
setInterval(() => {
  const control = state();
  if (!loginId || delivered || !control.finish) return;
  delivered = true;
  send({
    method: 'account/login/completed',
    params: {
      loginId: control.wrongId ? 'another-login' : loginId,
      success: control.success !== false,
      error: control.success === false ? 'private-error-marker' : null,
    },
  });
}, 20);
