import { expect, test } from 'bun:test';
import { fixture } from './helpers';

test('long tool observations do not exceed SQLite expression depth during recall', async () => {
  const r = await fixture();
  try {
    await r.memory.human.write('SAPPHIRE_OTTER is the deployment identifier.');
    const context =
      Array.from({ length: 1600 }, (_, i) => `unique_term_${i}`).join(' ') + ' SAPPHIRE_OTTER';
    const result = await r.memory.recall(context, 6000);
    expect(result.text).toContain('SAPPHIRE_OTTER');
  } finally {
    await r.dispose();
  }
});
