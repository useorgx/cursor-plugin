import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  PENDING_CONTEXT_FILENAME,
  WIZARD_ACK_VERSION,
  resolveSessionRuntimePaths,
} from './hydrate-context-pack.mjs';
import {
  endCursorSession,
  exitCodeForSessionEnd,
} from './session-end.mjs';

function argValue(args, name) {
  return args[args.indexOf(name) + 1];
}

function wizard(calls, mutate = (value) => value) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.stdin.once('finish', () => {
      calls.push({ command, args, options });
      const acknowledgement = mutate({
        ackVersion: WIZARD_ACK_VERSION,
        ready: false,
        state: 'missing',
        cleared: true,
        cwd: argValue(args, '--cwd'),
        sourceClient: argValue(args, '--source-client'),
        sessionId: argValue(args, '--session-id'),
      });
      child.stdout.end(JSON.stringify(acknowledgement));
      setImmediate(() => child.emit('close', 0));
    });
    child.kill = () => undefined;
    return child;
  };
}

test('sessionEnd records the terminal event, clears the exact lease, and removes only its runtime state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orgx-cursor-session-end-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const projectDir = realpathSync(project);
  const sessionId = 'cursor-native-session-a';
  const otherSessionId = 'cursor-native-session-b';
  const env = {
    PATH: process.env.PATH,
    ORGX_CURSOR_CONTEXT_HOME: join(root, 'runtime'),
  };
  const paths = resolveSessionRuntimePaths({ projectDir, sessionId, env });
  const otherPaths = resolveSessionRuntimePaths({
    projectDir,
    sessionId: otherSessionId,
    env,
  });
  mkdirSync(paths.directory, { recursive: true });
  mkdirSync(otherPaths.directory, { recursive: true });
  writeFileSync(paths.packPath, '{}');
  writeFileSync(join(paths.directory, PENDING_CONTEXT_FILENAME), '{}');
  writeFileSync(otherPaths.packPath, '{}');
  const wizardCalls = [];
  const recordCalls = [];
  try {
    const result = await endCursorSession({
      env,
      cwd: projectDir,
      stdinText: JSON.stringify({ cwd: projectDir, session_id: sessionId }),
      spawnImpl: wizard(wizardCalls),
      recordMain: async (input) => {
        recordCalls.push(input);
        return { ok: true, work_graph_spooled: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(exitCodeForSessionEnd(result), 0);
    assert.equal(recordCalls.length, 1);
    assert.deepEqual(recordCalls[0].argv, [
      '--event=session_end',
      '--source_client=cursor',
    ]);
    assert.equal(wizardCalls.length, 1);
    assert.deepEqual(wizardCalls[0].args, [
      'sessions',
      'context',
      'clear',
      '--cwd',
      projectDir,
      '--source-client',
      'cursor',
      '--session-id',
      sessionId,
      '--json',
    ]);
    assert.equal(existsSync(paths.directory), false);
    assert.equal(existsSync(otherPaths.packPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessionEnd never treats a wrong-session clear ack as success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orgx-cursor-session-end-ack-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const projectDir = realpathSync(project);
  try {
    const result = await endCursorSession({
      env: {
        PATH: process.env.PATH,
        ORGX_CURSOR_CONTEXT_HOME: join(root, 'runtime'),
      },
      stdinText: JSON.stringify({ cwd: projectDir, session_id: 'session-a' }),
      spawnImpl: wizard([], (ack) => ({ ...ack, sessionId: 'session-b' })),
      recordMain: async () => ({ ok: true, work_graph_spooled: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(exitCodeForSessionEnd(result), 1);
    assert.deepEqual(result.session_context, {
      cleared: false,
      reason: 'wizard_ack_mismatch',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
