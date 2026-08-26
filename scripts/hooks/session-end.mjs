#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

import {
  clearSessionWorkContext,
  isDirectRun,
  parseHookPayload,
  readStdin,
  removeSessionRuntimeState,
  resolveCanonicalProjectDirectory,
  resolveSessionId,
} from './hydrate-context-pack.mjs';
import {
  exitCodeForResult,
  main as recordWorkGraphEvent,
} from './record-work-graph-event.mjs';

export async function endCursorSession({
  env = process.env,
  stdinText = '',
  cwd = process.cwd(),
  spawnImpl = spawn,
  recordMain = recordWorkGraphEvent,
} = {}) {
  const payload = parseHookPayload(stdinText);
  const projectDir = resolveCanonicalProjectDirectory(payload, env);
  const sessionId = resolveSessionId(payload);

  let recordResult;
  try {
    recordResult = await recordMain({
      argv: ['--event=session_end', '--source_client=cursor'],
      env,
      stdinText,
      cwd,
    });
  } catch {
    recordResult = { ok: false, work_graph_spooled: false };
  }

  const clearance = await clearSessionWorkContext({
    projectDir,
    sessionId,
    env,
    spawnImpl,
  });
  const runtimeStateRemoved =
    projectDir && sessionId
      ? removeSessionRuntimeState({ projectDir, sessionId, env })
      : false;

  return {
    ok:
      exitCodeForResult(recordResult) === 0 &&
      clearance.cleared &&
      runtimeStateRemoved,
    work_graph: recordResult,
    session_context: clearance,
    runtime_state_removed: runtimeStateRemoved,
    project_dir: projectDir,
    session_id: sessionId,
  };
}

export function exitCodeForSessionEnd(result) {
  return result?.ok === true ? 0 : 1;
}

if (isDirectRun({ moduleUrl: import.meta.url })) {
  readStdin()
    .then((stdinText) => endCursorSession({ stdinText }))
    .then((result) => process.exit(exitCodeForSessionEnd(result)))
    .catch(() => process.exit(1));
}
