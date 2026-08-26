import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CURSOR_MCP_DEEPLINK_PATTERN =
  /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=([^&\s)]+)&config=([A-Za-z0-9_-]+)/;

const requiredFiles = [
  '.cursor-plugin/plugin.json',
  '.mcp.json',
  'rules/orgx-execution-loop.mdc',
  'hooks/hooks.json',
  'scripts/hooks/record-work-graph-event.mjs',
  'scripts/hooks/session-summary-bridge.mjs',
  'scripts/hooks/cursor-context-runtime.mjs',
  'scripts/hooks/hydrate-context-pack.mjs',
  'scripts/hooks/session-end.mjs',
  'scripts/hooks/orgx-work-graph-reconcile.mjs',
  'commands/orgx-start-workstream.md',
  'skills/orgx-execution-control-plane/SKILL.md',
  'skills/orgx-runtime-reporting/SKILL.md',
  'agents/orchestrator.md'
];

const missing = requiredFiles.filter((file) => !existsSync(resolve(file)));
if (missing.length) {
  console.error('Missing required plugin files:');
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(resolve('.cursor-plugin/plugin.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(resolve('.mcp.json'), 'utf8'));
const hooks = JSON.parse(readFileSync(resolve('hooks/hooks.json'), 'utf8'));
const readme = readFileSync(resolve('README.md'), 'utf8');

if (!manifest.name || !manifest.version) {
  throw new Error('plugin.json must include at least name and version');
}
if (manifest.version !== packageJson.version) {
  throw new Error(
    `package.json version ${packageJson.version} must match plugin.json version ${manifest.version}`
  );
}

if (!mcp.mcpServers || !mcp.mcpServers.orgx || !mcp.mcpServers.orgx.url) {
  throw new Error('.mcp.json must define the orgx MCP server');
}

const deeplinkMatch = readme.match(CURSOR_MCP_DEEPLINK_PATTERN);
if (!deeplinkMatch) {
  throw new Error('README.md must include an Add OrgX MCP to Cursor deeplink');
}
const [, deeplinkName, deeplinkConfig] = deeplinkMatch;
if (decodeURIComponent(deeplinkName) !== 'orgx') {
  throw new Error(`Cursor MCP deeplink must install the orgx server; got ${deeplinkName}`);
}
const decodedDeeplinkConfig = JSON.parse(Buffer.from(deeplinkConfig, 'base64url').toString('utf8'));
if (JSON.stringify(decodedDeeplinkConfig) !== JSON.stringify(mcp.mcpServers.orgx)) {
  throw new Error('Cursor MCP deeplink config must match .mcp.json mcpServers.orgx');
}

if (hooks.version !== 1) {
  throw new Error('hooks/hooks.json must declare Cursor hook schema version 1');
}

if (!hooks.hooks || !hooks.hooks.sessionStart) {
  throw new Error('hooks/hooks.json must include sessionStart hooks');
}

for (const [eventName, scriptName] of [
  ['sessionStart', 'session-start.mjs'],
  ['sessionEnd', 'session-end.mjs'],
  ['beforeSubmitPrompt', 'before-submit-prompt.mjs'],
  ['preToolUse', 'pre-tool-use.mjs'],
  ['postToolUse', 'post-tool-use.mjs'],
  ['postToolUseFailure', 'post-tool-use-failure.mjs'],
  ['subagentStart', 'subagent-start.mjs'],
  ['subagentStop', 'subagent-stop.mjs'],
  ['stop', 'stop.mjs'],
  ['afterAgentResponse', 'after-agent-response.mjs']
]) {
  if (!Array.isArray(hooks.hooks[eventName]) || hooks.hooks[eventName].length === 0) {
    throw new Error(`hooks/hooks.json must include ${eventName} hooks`);
  }
  const hasOrgxCommand = hooks.hooks[eventName].some(
    (entry) =>
      entry &&
      typeof entry.command === 'string' &&
      entry.command.includes(`scripts/hooks/${scriptName}`)
  );
  if (!hasOrgxCommand) {
    throw new Error(`${eventName} must call scripts/hooks/${scriptName}`);
  }
}

if (
  !hooks.hooks.sessionStart.some(
    (entry) =>
      entry &&
      typeof entry.command === 'string' &&
      entry.command.includes('scripts/hooks/hydrate-context-pack.mjs')
  )
) {
  throw new Error('sessionStart must call scripts/hooks/hydrate-context-pack.mjs');
}

const hookScript = readFileSync(resolve('scripts/hooks/record-work-graph-event.mjs'), 'utf8');
const summaryBridgeScript = readFileSync(resolve('scripts/hooks/session-summary-bridge.mjs'), 'utf8');
const contextHydrationScript = readFileSync(
  resolve('scripts/hooks/hydrate-context-pack.mjs'),
  'utf8'
);
const contextRuntimeScript = readFileSync(
  resolve('scripts/hooks/cursor-context-runtime.mjs'),
  'utf8'
);
const sessionEndScript = readFileSync(resolve('scripts/hooks/session-end.mjs'), 'utf8');
const executionRule = readFileSync(resolve('rules/orgx-execution-loop.mdc'), 'utf8');
const installScript = readFileSync(resolve('scripts/install-local.mjs'), 'utf8');
if (!hookScript.includes('orgx_cursor_plugin_runtime_hook')) {
  throw new Error('record-work-graph-event.mjs must emit orgx_cursor_plugin_runtime_hook records');
}
if (!hookScript.includes('ORGX_WIZARD_HOOK_OUTBOX')) {
  throw new Error('record-work-graph-event.mjs must support ORGX_WIZARD_HOOK_OUTBOX');
}
if (hookScript.includes('transcript_path:')) {
  throw new Error('record-work-graph-event.mjs must not persist raw transcript paths');
}
if (!hookScript.includes('exitCodeForResult')) {
  throw new Error('record-work-graph-event.mjs must expose hook failure exit handling');
}
if (!summaryBridgeScript.includes('orgx-session-summary.mjs')) {
  throw new Error('session-summary bridge must delegate to the Wizard capture hook');
}
if (!summaryBridgeScript.includes("['run_end', 'RunEnd']")) {
  throw new Error('session-summary bridge must preserve the terminal run boundary');
}
if (summaryBridgeScript.includes('--work_episode_capture=bounded')) {
  throw new Error('session-summary bridge must not force bounded Work Episode capture');
}
for (const forbiddenField of ['tool_input:', 'tool_output:', 'transcript_path:', 'user_email:', 'error_message:']) {
  if (summaryBridgeScript.includes(forbiddenField)) {
    throw new Error(`session-summary bridge must not persist ${forbiddenField}`);
  }
}
for (const anchorVariable of [
  'ORGX_TASK_ID',
  'ORGX_WORKSTREAM_ID',
  'ORGX_INITIATIVE_ID',
  'ORGX_WORKSPACE_ID',
]) {
  if (!contextHydrationScript.includes(anchorVariable)) {
    throw new Error(`context-pack hydration must support ${anchorVariable}`);
  }
}
if (!contextHydrationScript.includes('data.sessionWorkContext')) {
  throw new Error('context-pack hydration must consume data.sessionWorkContext');
}
if (!contextHydrationScript.includes('/api/v1/context-pack')) {
  throw new Error('context-pack hydration must use the canonical v1 route');
}
if (!contextHydrationScript.includes('redirect: "error"')) {
  throw new Error('context-pack hydration must reject HTTP redirects');
}
if (
  contextHydrationScript.includes('localConfig?.apiKey') ||
  contextHydrationScript.includes('localConfig?.api_key') ||
  contextHydrationScript.includes('localConfig?.baseUrl') ||
  contextHydrationScript.includes('localConfig?.base_url')
) {
  throw new Error('project-local context config must remain credential-free');
}
for (const commandPart of ['"sessions"', '"context"', '"set"', '"--file"']) {
  if (!contextHydrationScript.includes(commandPart)) {
    throw new Error('context-pack hydration must use the Wizard sessions context set interface');
  }
}
if (!contextHydrationScript.includes('"clear"')) {
  throw new Error('context-pack hydration must clear stale exact-cwd activation');
}
for (const commandPart of [
  '"--source-client"',
  '"--session-id"',
  '"--context-sha256"',
]) {
  if (!contextHydrationScript.includes(commandPart)) {
    throw new Error(`context-pack hydration must include Wizard v2 argument ${commandPart}`);
  }
}
for (const contractToken of [
  'orgx-session-work-context-ack/v1',
  'orgx-session-work-context-activation/v2',
  'contextSha256',
  'additional_context',
  'parsed.value?.ok !== true',
]) {
  if (!contextHydrationScript.includes(contractToken)) {
    throw new Error(`context-pack hydration must enforce ${contractToken}`);
  }
}
if (!contextRuntimeScript.includes('ORGX_CURSOR_CONTEXT_HOME')) {
  throw new Error('Cursor context must support private runtime storage outside the project');
}
if (!contextRuntimeScript.includes('randomUUID()') || !contextRuntimeScript.includes('renameSync')) {
  throw new Error('Cursor context runtime writes must remain atomic');
}
if (
  !sessionEndScript.includes('clearSessionWorkContext') ||
  !sessionEndScript.includes('removeSessionRuntimeState')
) {
  throw new Error('sessionEnd must clear the exact Wizard lease and private runtime state');
}
if (!executionRule.includes('.cursor/orgx-context-pack.json')) {
  throw new Error('the always-on execution rule must consume the retained context pack');
}
if (!installScript.includes("fileURLToPath(import.meta.url)")) {
  throw new Error('install-local.mjs must resolve plugin root with fileURLToPath');
}
if (!installScript.includes("resolve(localPluginsDir, 'orgx')")) {
  throw new Error('install-local.mjs must install under the orgx plugin name');
}

const reconcilerScript = readFileSync(
  resolve('scripts/hooks/orgx-work-graph-reconcile.mjs'),
  'utf8'
);
if (!reconcilerScript.includes('/api/client/work-graph/reports')) {
  throw new Error('orgx-work-graph-reconcile.mjs must post to Work Graph reports');
}
if (!reconcilerScript.includes('raw_transcripts_sent: false')) {
  throw new Error('orgx-work-graph-reconcile.mjs must preserve summary-only reporting');
}

console.log('Plugin manifest, MCP config, and hooks look valid.');
