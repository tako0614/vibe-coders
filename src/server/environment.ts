import { hostname, platform, arch, release, userInfo } from 'node:os';
import { z } from 'zod';
import { shellEnvironment } from './runs';

export const environmentSchema = z
  .object({
    programs: z.array(z.string().min(1).max(240)).max(30).default([]),
  })
  .strict();
export function inspectEnvironment(home: string, input: unknown) {
  const { programs } = environmentSchema.parse(input);
  const env: Record<string, string> = shellEnvironment();
  return {
    host: hostname(),
    platform: platform(),
    arch: arch(),
    release: release(),
    uid: userInfo().uid,
    home,
    programs: Object.fromEntries(
      programs.map((name) => [name, Bun.which(name, { PATH: env.PATH })]),
    ),
    packageManagers: Object.fromEntries(
      ['npm', 'bun', 'apt-get', 'dnf', 'pacman', 'brew', 'winget'].map((name) => [
        name,
        Bun.which(name),
      ]),
    ),
    display: { x11: process.env.DISPLAY || null, wayland: process.env.WAYLAND_DISPLAY || null },
  };
}

export const environmentInstructions = `
[Environment and MCP setup]
Use MCP for external capabilities; Chrome is one possible MCP server, not a built-in browser tool.
When a requested capability is missing, use environment_inspect and connections_list first. Inspect the target host, existing processes, installed commands and configured MCPs. Use web_fetch on official installation/setup documentation, then shell_exec to install required ordinary applications and MCP server packages. Record the installation source, selected version, host and observed result in your progress. Check for partial installations before retrying.
Use mcp_add to register and discover a new connection. Use mcp_update with the current config revision to correct an existing configuration, and mcp_reconnect to retry it. Connect/discovery runs return immediately; inspect run_read and actual discovered tools before claiming a capability works. Tools become available on the next model call without restarting the conversation.
For Chrome, install an ordinary Chrome on the intended desktop host if absent, consult the official Chrome DevTools MCP documentation, and register its documented stdio command/arguments using mcp_add. Prefer connecting to the user's normal Chrome with --autoConnect or its explicitly configured debugging endpoint. Do not silently create a replacement automation profile or duplicate an existing browser. Installing a package, starting Chrome, connecting MCP, and reading a page are separate checks. Set targetId=desktop for an MCP that observes or controls the shared screen, and ask for the browser's connection permission only when required.
Use human_request for OS/browser actions only the user can perform. Hand the affected desktop to the human before login or private input; other work can continue. Do not claim to control a desktop without an actual connection.
The parent model can use a Codex subscription or an OpenAI-compatible API. For Codex, check codex_status. If its CLI is absent, use the same environment-inspection and official installation workflow. Use codex_login to start managed sign-in. Only the dedicated user UI shows its login URL/device code; never request passwords, tokens or codes in chat, run output or memory. With the Codex subscription provider, sign-in supplies the parent model; a missing login parks the parent inference until the login event. Managed child runs, timers and user forms still live independently. Credentials belong to Codex's own local authentication store.
`;
