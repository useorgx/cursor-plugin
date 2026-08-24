import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EVENT_MAP = new Map([
  ['session_start', 'SessionStart'],
  ['user_prompt', 'UserPromptSubmit'],
  ['pre_tool_use', 'PreToolUse'],
  ['post_tool_use', 'PostToolUse'],
  ['post_tool_use_failure', 'PostToolUseFailure'],
  ['subagent_start', 'SubagentStart'],
  ['subagent_stop', 'SubagentStop'],
  ['run_end', 'RunEnd'],
  ['session_end', 'SessionEnd'],
]);

function string(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function firstString(values) {
  if (!Array.isArray(values)) return undefined;
  return string(...values);
}

/**
 * Cursor plugin hooks execute from the installed plugin directory, not the
 * active workspace. The hook contract carries the actual workspace in both
 * `workspace_roots` and `CURSOR_PROJECT_DIR`; prefer that explicit context so
 * cwd-scoped OrgX work context is not looked up against the plugin cache.
 */
export function cursorWorkspaceCwd(
  payload = {},
  env = process.env,
  fallbackCwd = process.cwd()
) {
  return string(
    payload.cwd,
    payload.working_directory,
    payload.workspace,
    firstString(payload.workspace_roots),
    firstString(payload.workspaceRoots),
    env.CURSOR_PROJECT_DIR,
    env.CLAUDE_PROJECT_DIR,
    fallbackCwd
  );
}

function finiteDuration(...values) {
  const value = values.find(
    (candidate) => typeof candidate === 'number' && Number.isFinite(candidate)
  );
  return value === undefined ? undefined : Math.max(0, Math.round(value));
}

function safeActionDescriptor(payload, cwd) {
  const tool = string(payload.tool_name, payload.toolName, payload.tool?.name);
  if (!tool) return {};
  const input = payload.tool_input && typeof payload.tool_input === 'object'
    ? payload.tool_input
    : payload.input && typeof payload.input === 'object'
      ? payload.input
      : {};
  const normalized = String(tool ?? '').toLowerCase();
  const actionEffect = /read|grep|search|find|glob/.test(normalized)
    ? 'inspect'
    : /write|edit|patch|notebook/.test(normalized)
      ? 'change'
      : /bash|shell|terminal|exec/.test(normalized)
        ? 'execute'
        : 'invoke';
  const filePath = string(input.file_path, input.filePath, input.path, input.notebook_path);
  if (filePath) {
    const absolute = resolve(cwd, filePath);
    const root = resolve(cwd);
    return {
      action_effect: actionEffect,
      action_target: absolute.startsWith(`${root}/`)
        ? `file:${absolute.slice(root.length + 1)}`
        : `file:${basename(absolute)}`,
    };
  }
  const command = string(input.command, payload.command);
  const executable = command?.trim().split(/\s+/)[0];
  const commandName = executable ? basename(executable) : undefined;
  return {
    action_effect: actionEffect,
    action_target:
      commandName && /^(?:pnpm|npm|npx|node|git|rg|grep|find|python|python3|pytest|vitest|jest|tsc|curl|gh|make|echo)$/.test(commandName)
        ? `command:${commandName}`
        : undefined,
  };
}

export function canonicalCursorEvent(event) {
  return EVENT_MAP.get(String(event || '').trim().toLowerCase()) ?? null;
}

/**
 * Keep only fields admitted by the Wizard summary hook. A bounded user-request
 * excerpt may cross when the user enabled work-episode capture; tool inputs,
 * results, transcript paths, identity, and error text never do.
 */
export function sanitizeCursorPayload(
  payload = {},
  cwd = process.cwd(),
  env = process.env
) {
  const workspaceCwd = cursorWorkspaceCwd(payload, env, cwd);
  const action = safeActionDescriptor(payload, workspaceCwd);
  return {
    session_id: string(
      payload.session_id,
      payload.sessionId,
      payload.conversation_id,
      payload.conversationId,
      payload.thread_id,
      payload.threadId
    ),
    turn_id: string(
      payload.turn_id,
      payload.turnId,
      payload.generation_id,
      payload.generationId
    ),
    cwd: workspaceCwd,
    tool_name: string(payload.tool_name, payload.toolName, payload.tool?.name),
    tool_use_id: string(payload.tool_use_id, payload.toolUseId),
    duration_ms: finiteDuration(payload.duration_ms, payload.duration),
    permission_mode: string(payload.permission_mode, payload.permissionMode),
    prompt: string(payload.prompt, payload.user_prompt, payload.message, payload.message?.text),
    root_session_id: string(payload.root_session_id, payload.rootSessionId),
    parent_session_id: string(payload.parent_session_id, payload.parentSessionId),
    resumed_from_session_id: string(
      payload.resumed_from_session_id,
      payload.resumedFromSessionId
    ),
    ...action,
  };
}

function defaultHookPath(env) {
  return (
    string(env.ORGX_SESSION_SUMMARY_HOOK_PATH) ??
    join(
      string(env.XDG_CONFIG_HOME) ?? join(homedir(), '.config'),
      'useorgx',
      'wizard',
      'hooks',
      'orgx-session-summary.mjs'
    )
  );
}

function autoFlushDisabled(value) {
  return ['off', 'false', '0'].includes(String(value ?? '').trim().toLowerCase());
}

function triggerFlush({ env, spawnImpl, queueDir }) {
  if (autoFlushDisabled(env.ORGX_SESSION_SUMMARY_AUTO_FLUSH)) return false;
  try {
    const args = ['hooks', 'flush', '--background', '--limit=25'];
    if (queueDir) args.push(`--queue=${queueDir}`);
    const child = spawnImpl('orgx-wizard', args, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child?.on?.('error', () => undefined);
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

export async function bridgeCursorSessionSummary({
  event,
  payload = {},
  env = process.env,
  cwd = process.cwd(),
  hookPath = defaultHookPath(env),
  moduleLoader = (url) => import(url),
  spawnImpl = spawn,
} = {}) {
  const canonicalEvent = canonicalCursorEvent(event);
  if (!canonicalEvent) return { ok: true, skipped: 'unsupported_event' };
  if (!existsSync(hookPath)) return { ok: true, skipped: 'wizard_hook_unavailable' };

  const hook = await moduleLoader(pathToFileURL(hookPath).href);
  if (typeof hook?.main !== 'function') {
    return { ok: true, skipped: 'wizard_hook_incompatible' };
  }

  const queueDir = string(env.ORGX_SESSION_SUMMARY_QUEUE_DIR);
  const result = await hook.main({
    argv: [
      `--event=${canonicalEvent}`,
      '--source_client=cursor',
      '--work_episode_capture=bounded',
      ...(queueDir ? [`--queue_dir=${queueDir}`] : []),
    ],
    env,
    stdinText: JSON.stringify(sanitizeCursorPayload(payload, cwd, env)),
  });
  const fallbackDeliveryTriggered =
    result?.queued === true && result?.delivery_triggered !== true
      ? triggerFlush({ env, spawnImpl, queueDir })
      : false;

  return {
    ...result,
    adapter: 'cursor',
    canonical_event: canonicalEvent,
    fallback_delivery_triggered: fallbackDeliveryTriggered,
  };
}
