import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'vibe-coder-test', version: '1.0.0' });
server.registerTool(
  'request_input',
  { description: 'Request a nonsecret value', inputSchema: {} },
  async () => {
    const result = await server.server.elicitInput({
      message: 'Choose a label',
      requestedSchema: {
        type: 'object',
        properties: { label: { type: 'string', title: 'Label' } },
        required: ['label'],
      },
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);
server.registerTool('typed_input', { inputSchema: {} }, async () => {
  const result = await server.server.elicitInput({
    message: 'Typed values',
    requestedSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10 },
        ready: { type: 'boolean' },
      },
      required: ['count', 'ready'],
    },
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
});
server.registerTool('url_input', { inputSchema: {} }, async () => {
  const result = await server.server.elicitInput({
    mode: 'url',
    message: 'Complete login on the service',
    url: 'https://example.org/login',
    elicitationId: 'test-login',
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
});
server.registerTool('selection_input', { inputSchema: {} }, async () => {
  const result = await server.server.elicitInput({
    message: 'Choose features',
    requestedSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          oneOf: [
            { const: 'basic', title: 'Basic plan' },
            { const: 'pro', title: 'Pro plan' },
          ],
          default: 'basic',
        },
        features: {
          type: 'array',
          items: {
            anyOf: [
              { const: 'files', title: 'Files' },
              { const: 'browser', title: 'Browser' },
            ],
          },
          minItems: 1,
          maxItems: 2,
          default: ['files'],
        },
        slug: { type: 'string', minLength: 2, maxLength: 20, default: 'project' },
      },
      required: ['plan', 'features', 'slug'],
    },
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
