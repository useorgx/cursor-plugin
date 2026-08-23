# `@useorgx/cursor-plugin`

OrgX plugin for Cursor.

This repo contains the plugin artifact needed for Cursor Marketplace submission and local Cursor installs. It bundles the OrgX MCP server with Cursor-native rules, commands, hooks, skills, and specialist agents.

## What this plugin includes

- `.cursor-plugin/plugin.json` manifest
- `.mcp.json` pointing at the hosted OrgX MCP server
- Cursor rules for the OrgX execution loop
- Commands for starting and resuming workstreams, checking proof, and reviewing decisions
- Quiet hooks for prompts, session, tool, subagent, agent-run, and terminal lifecycle events
- Passive Work Graph hook outbox for audit-first reconciliation
- Specialist agents for engineering, product, design, operations, marketing, sales, and orchestration

## Local testing

1. Run `npm run check`
2. Run `npm run install:local`
3. Restart Cursor or run `Developer: Reload Window`
4. Confirm the plugin loads from `~/.cursor/plugins/local/orgx`

## npm installation

The same reviewed plugin bundle is published publicly for scripted installs:

```bash
npm install --global @useorgx/cursor-plugin
```

## Install the OrgX MCP server in Cursor

Use this one-click install link if you want the hosted OrgX MCP server in
Cursor before the full plugin is available in Cursor Marketplace:

[Add OrgX MCP to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=orgx&config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLnVzZW9yZ3guY29tL21jcCJ9)

Cursor should prompt to add an `orgx` MCP server with:

```json
{
  "type": "http",
  "url": "https://mcp.useorgx.com/mcp"
}
```

## Hook behavior

Cursor lifecycle hooks call `scripts/hooks/record-work-graph-event.mjs`. The
script writes compact, redacted JSONL events to
`~/.config/useorgx/wizard/hooks/events.jsonl` by default, or to
`ORGX_WIZARD_HOOK_OUTBOX` when set.

When the Wizard session-summary hook is installed, the same adapter also sends
an allowlisted lifecycle shape to that local hook. `stop` becomes a terminal
`RunEnd` capture, while local `sessionEnd` remains a whole-conversation terminal
capture. The Wizard owns the durable queue, acknowledgement, retry, and AWR
delivery path. The adapter never forwards prompts, tool inputs or outputs,
transcript paths, user email, or error text.

Set `ORGX_SESSION_SUMMARY_AUTO_FLUSH=off` for a deliberately offline run. The
adapter and Wizard retain the capture without starting a delivery worker;
`orgx-wizard hooks flush` can replay it later with server acknowledgement.

Cursor cloud agents support the prompt, tool, subagent, and `stop` subset but
do not run the local `sessionStart` or `sessionEnd` hooks. Cloud proof is
therefore capability-bounded: `RunEnd` can issue a run receipt when the shared
Wizard hook and authenticated delivery worker are available, while a missing
local Wizard is reported as capture unavailable rather than silently claimed.

These hook records are a passive backstop for later Work Graph reconciliation.
They should answer whether meaningful work happened without durable OrgX
writeback. They do not store raw prompts, raw transcripts, API keys, tokens, or
storage state.

Unexpected hook failures are reported to OrgX Sentry so release regressions are
visible across Cursor installs. Sentry loads only after an error, keeping the
normal high-frequency hook path dependency-free and fast. Reports exclude raw
prompts, tool inputs and outputs, credentials, cookies, request bodies, request
headers, query strings, and local usernames. Set `ORGX_TELEMETRY_DISABLED=1`,
`ORGX_SENTRY_DISABLED=1`, or `CURSOR_TELEMETRY_DISABLED=1` to disable reporting.
Self-hosted deployments can override the destination with `ORGX_SENTRY_DSN`.

Generate a local summary-only Work Graph report without credentials:

```bash
node scripts/hooks/orgx-work-graph-reconcile.mjs --output /tmp/orgx-work-graph-report.json
```

Post the report to OrgX only when explicitly requested:

```bash
ORGX_API_KEY=... node scripts/hooks/orgx-work-graph-reconcile.mjs --post
```

## Marketplace

Cursor plugin docs:

- `https://cursor.com/docs/plugins`
- `https://cursor.com/docs/reference/plugins`
- `https://cursor.com/marketplace/publish`

The current repo is the product artifact that was previously missing. `orgx-mcp` is only the remote MCP server; Cursor Marketplace expects a plugin bundle repo like this one.
