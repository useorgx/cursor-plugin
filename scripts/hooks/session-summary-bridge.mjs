import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export function canonicalCursorEvent(event) {
  return EVENT_MAP.get(String(event || '').trim().toLowerCase()) ?? null;
}

/**
 * Keep only metadata admitted by the Wizard summary hook. Cursor also provides
 * prompts, tool inputs/results, transcript paths, user email, and error text;
 * none of those cross this adapter boundary.
 */
export function sanitizeCursorPayload(
  payload = {},
  cwd = process.cwd(),
  env = process.env
) {
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
    cwd: cursorWorkspaceCwd(payload, env, cwd),
    tool_name: string(payload.tool_name, payload.toolName, payload.tool?.name),
    tool_use_id: string(payload.tool_use_id, payload.toolUseId),
    duration_ms: finiteDuration(payload.duration_ms, payload.duration),
    permission_mode: string(payload.permission_mode, payload.permissionMode),
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
