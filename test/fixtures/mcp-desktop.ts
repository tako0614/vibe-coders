import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'desktop-fixture', version: '1.0.0' });
server.registerTool('environment', { inputSchema: {} }, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({ display: process.env.DISPLAY, authority: process.env.XAUTHORITY }),
    },
  ],
}));
await server.connect(new StdioServerTransport());
