# AGENTS.md

Guidelines for Codex and other agents working in `useorgx/cursor-plugin`.

## Project

This repo packages the OrgX Cursor plugin: manifest, MCP config, rules, commands, hooks, skills, and specialist agents.

## Setup

For Codex cloud, use:

```bash
bash .codex/setup-cloud.sh
```

Maintenance script for cached environments:

```bash
bash .codex/maintenance-cloud.sh
```

## Verification

```bash
npm run check
```

Do not run local install flows in Codex cloud unless the task specifically needs to inspect install behavior. `npm run install:local` writes to the user plugin directory and is a local-machine verification step.
