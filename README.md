# `@useorgx/cursor-plugin`

OrgX plugin for Cursor.

This repo contains the plugin artifact needed for Cursor Marketplace submission and local Cursor installs. It bundles the OrgX MCP server with Cursor-native rules, commands, hooks, skills, and specialist agents.

## What this plugin includes

- `.cursor-plugin/plugin.json` manifest
- `.mcp.json` pointing at the hosted OrgX MCP server
- Cursor rules for the OrgX execution loop
- Commands for starting and resuming workstreams, checking proof, and reviewing decisions
- Quiet hooks for session, tool, and subagent lifecycle events
- Passive Work Graph hook outbox for audit-first reconciliation
- Specialist agents for engineering, product, design, operations, marketing, sales, and orchestration

## Local testing

1. Run `npm run verify`
2. Run `npm run install:local`
3. Restart Cursor or run `Developer: Reload Window`
4. Confirm the plugin loads from `~/.cursor/plugins/local/orgx`

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

These hook records are a passive backstop for later Work Graph reconciliation.
They should answer whether meaningful work happened without durable OrgX
writeback. They do not store raw prompts, raw transcripts, API keys, tokens, or
storage state.

## Marketplace

Cursor plugin docs:

- `https://cursor.com/docs/plugins`
- `https://cursor.com/docs/reference/plugins`
- `https://cursor.com/marketplace/publish`

The current repo is the product artifact that was previously missing. `orgx-mcp` is only the remote MCP server; Cursor Marketplace expects a plugin bundle repo like this one.
