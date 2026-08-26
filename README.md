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
`RunEnd` capture. `afterAgentResponse` is the equivalent headless CLI fallback
for Cursor versions that do not emit `stop`; if both fire, the second event is
an idempotent no-op. Local `sessionEnd` remains a whole-conversation terminal
capture. The Wizard owns the durable queue, acknowledgement, retry, and AWR
delivery path. The plugin sends the current user request to the local Wizard
hook only when the Wizard's capture policy allows it. The default is
metadata-only; set `ORGX_SESSION_WORK_EPISODE_CAPTURE=bounded` only after the
user opts into Work Episode capture (at most 12 redacted excerpts, 600
characters each). The adapter does not override that choice. It never sends
tool arguments, tool results, transcript paths, user email, or error text. The
queued summary declares when request excerpts are included.

Set `ORGX_SESSION_SUMMARY_AUTO_FLUSH=off` for a deliberately offline run. The
adapter and Wizard retain the capture without starting a delivery worker;
`orgx-wizard hooks flush` can replay it later with server acknowledgement.

Cursor cloud agents support the prompt, tool, subagent, response, and `stop` subset but
do not run the local `sessionStart` or `sessionEnd` hooks. Cloud proof is
therefore capability-bounded: `RunEnd` can issue a run receipt when the shared
Wizard hook and authenticated delivery worker are available, while a missing
local Wizard is reported as capture unavailable rather than silently claimed.

These hook records are a passive backstop for later Work Graph reconciliation.
They should answer whether meaningful work happened without durable OrgX
writeback. When bounded capture is enabled, they store only bounded, redacted
request excerpts—not full prompts, transcripts, API keys, tokens, or storage
state. Metadata-only capture stores no request excerpts.

## Session context hydration

On local `sessionStart`, Cursor passes the active project directory to the
context-pack hook together with Cursor's native session ID. Set `ORGX_API_KEY`
in the launching environment and configure at least one scope ID. The hook
sends every configured ID to `/api/v1/context-pack`; task, workstream,
initiative, then workspace determines the most-specific anchor. A project-local
`.cursor/orgx.local.json` or
`.claude/orgx.local.json` may supply scope IDs, but never credentials or a base
URL. Set a non-default `ORGX_BASE_URL` only in the launching environment.

The hook returns one bounded `sessionStart.additional_context` value, so the
briefing is available to the first model request without a repository read. It
stores the fetched pack and any pending activation in a private `0700`
per-session runtime directory, with `0600` files, outside the repository. The
default root is the platform state or config directory under
`useorgx/cursor/sessions`; set an absolute `ORGX_CURSOR_CONTEXT_HOME` to choose
another private runtime root. Directory names are SHA-256 keys derived from the
resolved project directory, source client, and native session ID. Runtime
files never appear in `git status` and parallel sessions in one project do not
share a pack or activation state.

When the response includes `data.sessionWorkContext`, the hook forwards that
exact object to the Wizard's supported activation interface:

```bash
orgx-wizard sessions context set --file - \
  --cwd "$CURSOR_PROJECT_DIR" \
  --source-client cursor \
  --session-id "$CURSOR_SESSION_ID" \
  --context-sha256 "$CONTEXT_SHA256" \
  --json
```

`CONTEXT_SHA256` is the lowercase SHA-256 digest of recursively key-sorted JSON;
array order is preserved and undefined values are omitted. The Wizard validates
the object and binds its short TTL to the resolved project directory, `cursor`,
and the native session ID. Cursor accepts activation only when the Wizard
returns `ackVersion: "orgx-session-work-context-ack/v1"`,
`activationVersion: "orgx-session-work-context-activation/v2"`, `ready: true`,
`state: "ready"`, and the exact directory, client, session, and digest.

If fetching or validation fails, the hook asks the Wizard to clear that exact
session lease and removes its private runtime state. If activation itself fails,
the unmodified object remains only in that session's private pending file and
is injected as informational context, never as active authority. Empty or
invalid authoritative responses also clear the exact lease. `sessionEnd`
records the terminal Work Graph event, clears the same lease with a verified
missing-state acknowledgement, and removes only that session's runtime files.
Hook input, HTTP bodies, session context, Wizard output, and injected context
are all bounded. Hydration remains fail-open for Cursor while authority fails
closed: a missing credential, scope, server result, or valid Wizard
acknowledgement does not prevent the session from starting and cannot preserve
stale OrgX authority.

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
