import assert from 'node:assert/strict';
import { Config, Vault } from '../src/server/config';
import { fixture, eventually } from '../test/helpers';
import { join } from 'node:path';

const config = new Config(),
  subscription = process.argv.includes('--codex'),
  provider = config.read().provider;
if (!provider && !subscription)
  throw new Error('Configure the real provider URL and model using setup/WebUI before this check.');
const vault = new Vault(config.directory);
if (
  !subscription &&
  provider?.kind !== 'codex' &&
  provider?.keyRequired &&
  !vault.get('provider:main', provider.revision)
)
  throw new Error('Save the provider key through the dedicated secret input first.');
const r = await fixture(null);
if (subscription || provider?.kind === 'codex') {
  const models = await r.codex.models();
  const model =
    provider?.kind === 'codex'
      ? provider.model
      : models.find((m) => m.isDefault)?.id || models[0]?.id;
  if (!model) throw new Error('No Codex models are available.');
  r.config.update(r.config.read().revision, (c) => {
    c.provider = {
      kind: 'codex',
      revision: 1,
      model,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      keyRequired: false,
      supportsImages: true,
    };
  });
  if (!(await r.codex.refresh()).subscriptionReady)
    throw new Error('Sign in to Codex with ChatGPT before running this check.');
} else {
  r.config.update(r.config.read().revision, (c) => {
    c.provider = provider;
  });
  const key = vault.get('provider:main', provider!.revision);
  if (key) r.vault.put('provider:main', provider!.revision, crypto.randomUUID(), key);
}
let answered = false;
const answer = () => {
  for (const card of r.store.snapshot(r.id).requests) {
    if (card.state !== 'pending' || card.spec.kind !== 'input') continue;
    r.human.answer(card.id, {
      revision: card.revision,
      operationId: crypto.randomUUID(),
      values: Object.fromEntries(
        card.spec.fields.map((f) => [f.name, f.type === 'choice' ? f.options![0].value : 'green']),
      ),
    });
    answered = true;
  }
};
try {
  r.store.changes.on('change', answer);
  r.agent.submit(
    r.id,
    'This is an end-to-end test in a temporary repository. Use only file_read, file_write, memory_write, human_request and agent_wait. Do not invoke native_start or shell_exec. Read AGENT.md; create provider-proof.txt containing exactly PROVIDER_E2E_OK and a newline; read it back; save a memory that the test color is green; ask one nonsecret text question with human_request and then continue inspecting the file while waiting. You will receive the answer automatically. After receiving it, report the created file and color. Do not access other directories, use external services, or delegate.',
    crypto.randomUUID(),
  );
  await eventually(
    () =>
      r.store.history(r.id).some((m) => m.body.role === 'assistant') ||
      r.store.conversation(r.id).state === 'error',
    120000,
  );
  await eventually(() => ['idle', 'error'].includes(r.store.conversation(r.id).state), 120000);
  assert.equal(
    r.store.conversation(r.id).state,
    'idle',
    JSON.stringify(
      r.store
        .history(r.id)
        .filter((m) => m.body.role === 'system')
        .map((m) => m.body.content),
    ),
  );
  assert.equal(await Bun.file(join(r.home, 'provider-proof.txt')).text(), 'PROVIDER_E2E_OK\n');
  assert.equal(answered, true);
  assert.ok((await r.memory.human.search('green')).items.length);
  console.log(
    JSON.stringify({
      passed: true,
      model: r.config.read().provider!.model,
      provider: r.config.read().provider!.kind || 'openai',
      messages: r.store.history(r.id).length,
      humanAnswered: answered,
    }),
  );
} finally {
  r.store.changes.off('change', answer);
  await r.dispose();
}
