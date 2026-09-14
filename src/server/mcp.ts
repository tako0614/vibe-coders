import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Config, Vault, type McpConfig } from './config';
import { Store } from './store';
import { RunService, shellEnvironment } from './runs';
import { HumanService } from './human';
import type { ToolDefinition } from './model';
import { mcpSchema, type HumanSpec } from '../shared/contracts';
import { McpOAuth } from './mcp-auth';

type Connection = {
  client: Client;
  config: McpConfig;
  state: 'connecting' | 'connected' | 'error' | 'awaiting_auth';
  tools: ToolDefinition[];
  rawNames: Map<string, string>;
  queue: Promise<unknown>;
  activeConversation?: string;
  error?: string;
  abort?: AbortController;
  epoch?: number;
};
export class McpService {
  private connections = new Map<string, Connection>();
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly vault: Vault,
    readonly runs: RunService,
    readonly human: HumanService,
    readonly home: string,
  ) {
    store.changes.on('change', this.checkOwnership);
  }
  private checkOwnership = () => {
    let configured: McpConfig[] = [];
    try {
      configured = this.config.read().mcp;
    } catch {
      /* Invalid configuration retires live tools. */
    }
    for (const c of this.connections.values())
      if (
        this.store.stopped ||
        !configured.some(
          (item) =>
            item.name === c.config.name && item.enabled && item.revision === c.config.revision,
        ) ||
        (c.config.targetId === 'desktop' &&
          (this.store.get<string>('desktopOwner', 'agent') === 'human' ||
            (c.epoch !== undefined && c.epoch !== this.store.get('desktopEpoch', 0))))
      ) {
        c.abort?.abort();
        c.tools = [];
        void this.disconnect(c.config.name).catch(() => {});
      }
  };
  status() {
    return this.config.read().mcp.map((c) => {
      const live = this.connections.get(c.name);
      return {
        name: c.name,
        targetId: c.targetId,
        state: live?.state || 'disconnected',
        tools: live?.tools.length || 0,
        error: live?.error,
      };
    });
  }
  definitions() {
    return [...this.connections.values()]
      .filter((c) => c.state === 'connected')
      .flatMap((c) => c.tools);
  }
  configure(revision: number, input: unknown, createOnly = false) {
    this.store.assertEnabled();
    const connection = mcpSchema.parse(input);
    const next = this.config.update(revision, (config) => {
      const old = config.mcp.find((item) => item.name === connection.name);
      if (old && createOnly)
        throw new Error('Connection already exists. Use mcp_update or mcp_reconnect.');
      config.mcp = config.mcp.filter((item) => item.name !== connection.name);
      config.mcp.push({ ...connection, revision: (old?.revision || 0) + 1 });
    });
    this.checkOwnership();
    this.store.notify();
    return next;
  }
  connectRun(conversationId: string, name: string) {
    const connection = this.config.read().mcp.find((item) => item.name === name);
    if (!connection) throw new Error('MCP not found.');
    return this.runs.managed(conversationId, `Connect ${name}`, async (signal) => {
      await this.connect(connection, conversationId, signal);
      const status = this.status().find((item) => item.name === name);
      if (!status) throw new Error('MCP was removed.');
      return status;
    });
  }
  async remove(revision: number, name: string) {
    this.config.update(revision, (config) => {
      config.mcp = config.mcp.filter((item) => item.name !== name);
    });
    await this.disconnect(name);
    this.store.notify();
  }
  async connect(
    config: McpConfig,
    conversationId = this.store.listConversations()[0]?.id,
    signal?: AbortSignal,
  ) {
    this.store.assertEnabled();
    signal?.throwIfAborted();
    if (
      !this.config
        .read()
        .mcp.some((item) => item.name === config.name && item.revision === config.revision)
    )
      throw new Error('MCP configuration changed. Read connections_list before reconnecting.');
    if (
      config.targetId === 'desktop' &&
      this.store.get<string>('desktopOwner', 'agent') === 'human'
    )
      throw new Error('User owns this desktop.');
    await this.disconnect(config.name);
    this.store.assertEnabled();
    signal?.throwIfAborted();
    if (!config.enabled) return;
    const client = new Client(
      { name: 'vibe-coders', version: '0.1.5' },
      { capabilities: { elicitation: { form: {}, url: {} } } },
    );
    const c: Connection = {
      client,
      config,
      state: 'connecting',
      tools: [],
      rawNames: new Map(),
      queue: Promise.resolve(),
      epoch: this.store.get('desktopEpoch', 0),
    };
    this.connections.set(config.name, c);
    this.store.notify();
    const abort = () => {
      if (this.connections.get(config.name) === c)
        void this.disconnect(config.name).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      if (!c.activeConversation) return { action: 'decline' as const };
      const isUrl = 'url' in request.params;
      const schema =
        !isUrl && 'requestedSchema' in request.params ? request.params.requestedSchema : undefined;
      const fields: HumanSpec['fields'] = [];
      for (const [name, field] of Object.entries(schema?.properties || {})) {
        // MCP forms cannot ask for secrets. Unsupported schemas are declined,
        // never converted to an arbitrary HTML form or a secret collector.
        if (
          !['string', 'number', 'integer', 'boolean'].includes(field.type) ||
          /password|secret|token|api.?key/i.test(
            `${name} ${field.title || ''} ${field.description || ''}`,
          )
        )
          return { action: 'decline' as const };
        const choices =
          'enum' in field && Array.isArray(field.enum) ? (field.enum as string[]) : undefined;
        const constraint = field as Record<string, unknown>;
        if ('oneOf' in field || 'anyOf' in field || 'pattern' in field)
          return { action: 'decline' as const };
        fields.push({
          name,
          label: field.title || name,
          type: choices
            ? 'choice'
            : field.type === 'string'
              ? 'text'
              : (field.type as 'number' | 'integer' | 'boolean'),
          required: schema?.required?.includes(name) ?? false,
          ...Object.fromEntries(
            ['minimum', 'maximum', 'minLength', 'maxLength', 'format']
              .filter((k) => k in constraint)
              .map((k) => [k, constraint[k]]),
          ),
          ...(choices ? { options: choices.map((value) => ({ label: value, value })) } : {}),
        });
      }
      const card = this.human.create(c.activeConversation, {
        kind: isUrl ? 'action' : 'input',
        title: `${config.name} からの入力依頼`,
        message: request.params.message,
        fields,
        ...(isUrl && 'url' in request.params ? { url: request.params.url } : {}),
      });
      return await new Promise<
        | { action: 'accept'; content?: Record<string, string | number | boolean> }
        | { action: 'cancel' }
      >((resolve) => {
        const finish = (
          result:
            | { action: 'accept'; content?: Record<string, string | number | boolean> }
            | { action: 'cancel' },
        ) => {
          this.store.changes.off('change', check);
          extra.signal.removeEventListener('abort', abort);
          resolve(result);
        };
        const check = () => {
          const r = this.human.get(card.id);
          if (r.state === 'resolved')
            finish({
              action: 'accept',
              ...(isUrl
                ? {}
                : {
                    content: Object.fromEntries(
                      fields.flatMap((field) => {
                        const value = (r.result?.answers as Record<string, string>)?.[field.name];
                        if (value === undefined || (!field.required && value === '')) return [];
                        return [
                          [
                            field.name,
                            field.type === 'boolean'
                              ? value === 'true'
                              : ['number', 'integer'].includes(field.type)
                                ? Number(value)
                                : value,
                          ],
                        ];
                      }),
                    ),
                  }),
            });
          else if (['cancelled', 'expired'].includes(r.state)) finish({ action: 'cancel' });
        };
        const abort = () => {
          this.human.close(card.id);
          finish({ action: 'cancel' });
        };
        this.store.changes.on('change', check);
        extra.signal.addEventListener('abort', abort, { once: true });
        if (extra.signal.aborted) abort();
        else check();
      });
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refresh(c);
      } catch {
        this.fail(c);
      }
    });
    client.onclose = () => {
      c.state = 'error';
      c.tools = [];
      c.error ||= 'Connection closed.';
      this.store.notify();
    };
    client.onerror = () => {
      c.error = 'MCP transport error.';
      this.store.notify();
    };
    try {
      signal?.throwIfAborted();
      if (this.connections.get(config.name) !== c) throw new Error('Connection was replaced.');
      if (config.transport === 'stdio' && !Bun.which(config.command!)) {
        c.error = `MCP command is not installed: ${config.command}. Use environment_inspect and install it first.`;
        throw new Error(c.error);
      }
      const key = this.vault.get(`mcp:${config.name}`, config.revision);
      const auth = config.oauth
        ? new McpOAuth(this.config, this.vault, this.store, this.human, config, conversationId)
        : undefined;
      const transport =
        config.transport === 'stdio'
          ? new StdioClientTransport({
              command: config.command!,
              args: config.args,
              cwd: this.home,
              env: {
                ...shellEnvironment(),
                ...(key && config.credentialEnv ? { [config.credentialEnv]: key } : {}),
              },
              stderr: 'pipe',
            })
          : new StreamableHTTPClientTransport(new URL(config.url!), {
              authProvider: auth,
              requestInit: { headers: key && !auth ? { Authorization: `Bearer ${key}` } : {} },
            });
      await client.connect(transport, { timeout: 20000 });
      signal?.throwIfAborted();
      this.store.assertEnabled();
      if (this.connections.get(config.name) !== c) throw new Error('Connection was replaced.');
      await this.refresh(c);
      signal?.throwIfAborted();
      this.store.assertEnabled();
      if (this.connections.get(config.name) !== c) throw new Error('Connection was replaced.');
      c.state = 'connected';
      c.error = undefined;
      this.store.notify();
    } catch {
      if (signal?.aborted || this.connections.get(config.name) !== c) {
        await client.close().catch(() => {});
        throw new Error('MCP connection was cancelled or replaced.');
      }
      if (
        config.oauth &&
        new McpOAuth(this.config, this.vault, this.store, this.human, config, conversationId).read()
          .state
      ) {
        c.state = 'awaiting_auth';
        c.tools = [];
        c.error = undefined;
        await client.close().catch(() => {});
        c.state = 'awaiting_auth';
        c.error = undefined;
        this.store.notify();
        return;
      }
      this.fail(c);
      await client.close().catch(() => {});
      throw new Error(`MCP ${config.name} could not connect.`);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async finishOAuth(state: string, code?: string) {
    this.store.assertEnabled();
    for (const config of this.config.read().mcp.filter((c) => c.oauth && c.transport === 'http')) {
      const auth = new McpOAuth(
        this.config,
        this.vault,
        this.store,
        this.human,
        config,
        this.store.listConversations()[0].id,
      );
      if (auth.read().state !== state) continue;
      const card = auth.consumeState(state);
      if (!code) {
        this.human.close(card);
        return;
      }
      const transport = new StreamableHTTPClientTransport(new URL(config.url!), {
        authProvider: auth,
      });
      await transport.finishAuth(code);
      this.store.assertEnabled();
      await this.connect(config, this.human.get(card).conversationId);
      if (this.connections.get(config.name)?.state !== 'connected')
        throw new Error('OAuth reconnect failed.');
      this.human.completeExternal(card, {
        status: 'connected',
        verification: 'verified',
        targetId: `mcp:${config.name}`,
      });
      return;
    }
    throw new Error('OAuth request not found or already used.');
  }
  private fail(c: Connection) {
    c.state = 'error';
    c.tools = [];
    c.error ||= 'Connection or tool discovery failed.';
    this.store.notify();
  }
  private async refresh(c: Connection) {
    const tools: ToolDefinition[] = [],
      rawNames = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = await c.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        const name = `mcp_${c.config.name}_${createHash('sha256').update(tool.name).digest('hex').slice(0, 16)}`;
        rawNames.set(name, tool.name);
        tools.push({
          name,
          description: `[${c.config.name}/${tool.name}] ${(tool.description || '').slice(0, 3000)}`,
          parameters: tool.inputSchema,
        });
      }
      cursor = page.nextCursor;
      if (tools.length > 1000) throw new Error('MCP tool list exceeds the discovery bound.');
    } while (cursor);
    c.tools = tools;
    c.rawNames = rawNames;
    this.store.notify();
  }
  call(conversationId: string, name: string, args: Record<string, unknown>) {
    const c = [...this.connections.values()].find(
      (c) => c.state === 'connected' && c.rawNames.has(name),
    );
    if (!c) throw new Error('MCP tool is not connected. Refresh its connection.');
    const rawName = c.rawNames.get(name)!;
    const epoch = this.store.get('desktopEpoch', 0);
    const check = () => {
      this.store.assertEnabled();
      if (
        c.config.targetId === 'desktop' &&
        (this.store.get<string>('desktopOwner', 'agent') === 'human' ||
          this.store.get('desktopEpoch', 0) !== epoch)
      )
        throw new Error('Desktop ownership changed.');
      if (this.config.targetVersion(`mcp:${c.config.name}`) !== c.config.revision)
        throw new Error('MCP configuration changed.');
    };
    check();
    return this.runs.managed(conversationId, `${c.config.name}: ${rawName}`, async (signal) => {
      const previous = c.queue;
      let release!: () => void;
      c.queue = new Promise<void>((r) => {
        release = r;
      });
      try {
        await previous;
        signal.throwIfAborted();
        check();
        c.activeConversation = conversationId;
        c.epoch = epoch;
        c.abort = new AbortController();
        const result = await c.client.callTool({ name: rawName, arguments: args }, undefined, {
          signal: AbortSignal.any([signal, c.abort.signal]),
          timeout: 30 * 60 * 1000,
        });
        check();
        if (JSON.stringify(result).length > 4 * 1024 * 1024)
          throw new Error('MCP result exceeds 4 MiB.');
        return result as Record<string, unknown>;
      } finally {
        c.abort = undefined;
        c.epoch = undefined;
        c.activeConversation = undefined;
        release();
      }
    });
  }
  async disconnect(name: string) {
    const c = this.connections.get(name);
    if (c) {
      this.connections.delete(name);
      await c.client.close();
      this.store.notify();
    }
  }
  async close() {
    await Promise.allSettled([...this.connections.keys()].map((name) => this.disconnect(name)));
  }
}
