import assert from 'node:assert/strict';
import { createHttp } from '../src/server/http';
import { fixture } from '../test/helpers';

const runtime = await fixture();
const originalDirectory = process.cwd();
const headers = {
  Authorization: `Basic ${Buffer.from('owner:test-only-password-123').toString('base64')}`,
};
try {
  // Serving must work when the CLI is started from a different repository Home.
  process.chdir(runtime.home);
  const { app } = createHttp(runtime);
  assert.equal((await app.request('/')).status, 401);
  const response = await app.request('/', { headers });
  assert.equal(response.status, 200, 'Hono must serve the built React entry point');
  assert.match(response.headers.get('Content-Type') || '', /text\/html/);
  const html = await response.text();
  assert.match(html, /id="root"/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
  assert.ok(
    assets.some((path) => path.endsWith('.js')),
    'Entry JavaScript must be linked',
  );
  assert.ok(
    assets.some((path) => path.endsWith('.css')),
    'Styles must be linked',
  );
  for (const path of assets) {
    assert.equal((await app.request(path)).status, 401);
    const asset = await app.request(path, { headers });
    assert.equal(asset.status, 200, `Missing built asset: ${path}`);
    assert.match(
      asset.headers.get('Content-Type') || '',
      path.endsWith('.js') ? /javascript/ : /text\/css/,
    );
    assert.ok((await asset.arrayBuffer()).byteLength > 0);
  }
  console.log(`Built UI delivery passed: authenticated HTML and ${assets.length} assets.`);
} finally {
  process.chdir(originalDirectory);
  await runtime.dispose();
}
