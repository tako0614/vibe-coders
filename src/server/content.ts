import { Config, Vault } from './config';
import { shellEnvironment } from './runs';
export async function boundedBody(response: Response, limit = 1024 * 1024) {
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  if (reader)
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > limit) throw new Error('Response exceeds the size limit.');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
  return Buffer.concat(chunks);
}
export async function searchWeb(config: Config, vault: Vault, query: string, page = 1) {
  const settings = config.read().search;
  if (!settings) throw new Error('Configure a SearXNG endpoint or Brave Search in settings.');
  const url = new URL(settings.baseUrl);
  url.searchParams.set('q', query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (settings.engine === 'searxng') {
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageno', String(page));
  } else {
    const key = vault.get('search', settings.revision);
    if (!key) throw new Error('Enter the Brave Search API key using the dedicated secret form.');
    headers['X-Subscription-Token'] = key;
    url.searchParams.set('count', '10');
    url.searchParams.set('offset', String(page - 1));
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Search provider returned HTTP ${response.status}.`);
  }
  const body = JSON.parse((await boundedBody(response)).toString()) as Record<string, any>;
  const raw = settings.engine === 'searxng' ? body.results : body.web?.results;
  if (!Array.isArray(raw)) throw new Error('Search provider returned an invalid result.');
  const results = raw
    .slice(0, 10)
    .filter((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url))
    .map((r) => ({
      title: String(r.title || '').slice(0, 500),
      url: r.url,
      excerpt: String(r.content || r.description || '').slice(0, 3000),
    }));
  return {
    query,
    page,
    results,
    fetchedAt: new Date().toISOString(),
    nextPage: results.length === 10 && page < 10 ? page + 1 : null,
    source: settings.engine,
  };
}
export async function extractPdf(data: Uint8Array) {
  if (data.length > 4 * 1024 * 1024 || Buffer.from(data.subarray(0, 5)).toString() !== '%PDF-')
    throw new Error('Attach a PDF of at most 4 MiB.');
  if (!Bun.which('pdftotext'))
    throw new Error('Install Poppler (pdftotext) on the backend host to read PDFs.');
  const proc = Bun.spawn(
    ['pdftotext', '-f', '1', '-l', '20', '-layout', '-enc', 'UTF-8', '-', '-'],
    {
      stdin: data,
      stdout: 'pipe',
      stderr: 'pipe',
      env: shellEnvironment(),
      timeout: 15000,
    },
  );
  try {
    const [body, code] = await Promise.all([
      boundedBody(new Response(proc.stdout), 2 * 1024 * 1024),
      proc.exited,
      boundedBody(new Response(proc.stderr), 16000),
    ]);
    if (code !== 0) throw new Error('PDF could not be read. It may be encrypted or damaged.');
    const text = body.toString('utf8');
    return {
      text: text.slice(0, 24000),
      pageRange: '1–20',
      truncated: text.length > 24000,
      note: 'Text layer from at most the first 20 pages. Images and scanned pages require OCR or image input.',
    };
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
}
