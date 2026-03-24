import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const requiredFiles = [
  '.cursor-plugin/plugin.json',
  '.mcp.json',
  'rules/orgx-execution-loop.mdc',
  'hooks/hooks.json',
  'commands/orgx-start-workstream.md',
  'skills/orgx-execution-control-plane/SKILL.md',
  'agents/orchestrator.md'
];

const missing = requiredFiles.filter((file) => !existsSync(resolve(file)));
if (missing.length) {
  console.error('Missing required plugin files:');
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(resolve('.cursor-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(resolve('.mcp.json'), 'utf8'));
const hooks = JSON.parse(readFileSync(resolve('hooks/hooks.json'), 'utf8'));

if (!manifest.name || !manifest.version) {
  throw new Error('plugin.json must include at least name and version');
}

if (!mcp.mcpServers || !mcp.mcpServers.orgx || !mcp.mcpServers.orgx.url) {
  throw new Error('.mcp.json must define the orgx MCP server');
}

if (!hooks.hooks || !hooks.hooks.sessionStart) {
  throw new Error('hooks/hooks.json must include sessionStart hooks');
}

console.log('Plugin manifest, MCP config, and hooks look valid.');
