import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bridgeCursorSessionSummary,
  canonicalCursorEvent,
  sanitizeCursorPayload,
} from './session-summary-bridge.mjs';

test('maps Cursor completion to the shared terminal run boundary', () => {
  assert.equal(canonicalCursorEvent('run_end'), 'RunEnd');
  assert.equal(canonicalCursorEvent('session_end'), 'SessionEnd');
  assert.equal(canonicalCursorEvent('post_tool_use'), 'PostToolUse');
  assert.equal(canonicalCursorEvent('unknown'), null);
});

test('allowlists lifecycle metadata and drops content-bearing Cursor fields', () => {
  const payload = sanitizeCursorPayload({
    conversation_id: 'conversation-1',
    generation_id: 'generation-2',
    cwd: '/work/repo',
    tool_name: 'Shell',
    tool_use_id: 'tool-3',
    duration: 42.4,
    user_email: 'private@example.test',
    transcript_path: '/private/transcript.jsonl',
    prompt: 'private prompt',
    tool_input: { command: 'private command' },
    tool_output: 'private output',
    error_message: 'private error',
  });

  assert.deepEqual(payload, {
    session_id: 'conversation-1',
    turn_id: 'generation-2',
    cwd: '/work/repo',
    tool_name: 'Shell',
    tool_use_id: 'tool-3',
    duration_ms: 42,
    permission_mode: undefined,
  });
  const serialized = JSON.stringify(payload);
  for (const secret of ['private@example.test', 'transcript', 'private prompt', 'private command', 'private output', 'private error']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('delegates to the installed Wizard hook and starts fallback delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgx-cursor-bridge-'));
  const hookPath = join(dir, 'orgx-session-summary.mjs');
  writeFileSync(hookPath, 'export async function main() {}\n', 'utf8');
  const calls = [];
  const spawns = [];
  let unrefed = false;
  try {
    const result = await bridgeCursorSessionSummary({
      event: 'run_end',
      payload: { conversation_id: 'conversation-1' },
      hookPath,
      env: { PATH: process.env.PATH },
      moduleLoader: async () => ({
        main: async (input) => {
          calls.push(input);
          return { ok: true, queued: true, delivery_triggered: false };
        },
      }),
      spawnImpl: (command, args, options) => {
        spawns.push({ command, args, options });
        return {
          on: () => undefined,
          unref: () => {
            unrefed = true;
          },
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, [
      '--event=RunEnd',
      '--source_client=cursor',
    ]);
    assert.deepEqual(JSON.parse(calls[0].stdinText), {
      session_id: 'conversation-1',
      cwd: process.cwd(),
    });
    assert.equal(result.fallback_delivery_triggered, true);
    assert.equal(spawns[0].command, 'orgx-wizard');
    assert.deepEqual(spawns[0].args, [
      'hooks',
      'flush',
      '--background',
      '--limit=25',
    ]);
    assert.equal(spawns[0].options.detached, true);
    assert.equal(unrefed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps an offline run queued without starting fallback delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgx-cursor-bridge-'));
  const hookPath = join(dir, 'orgx-session-summary.mjs');
  writeFileSync(hookPath, 'export async function main() {}\n', 'utf8');
  let spawns = 0;
  try {
    const result = await bridgeCursorSessionSummary({
      event: 'run_end',
      payload: { conversation_id: 'conversation-offline' },
      hookPath,
      env: {
        PATH: process.env.PATH,
        ORGX_SESSION_SUMMARY_AUTO_FLUSH: 'off',
      },
      moduleLoader: async () => ({
        main: async () => ({ ok: true, queued: true, delivery_triggered: false }),
      }),
      spawnImpl: () => {
        spawns += 1;
        throw new Error('offline capture must not spawn');
      },
    });

    assert.equal(result.fallback_delivery_triggered, false);
    assert.equal(spawns, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports a missing shared hook without inventing capture', async () => {
  const result = await bridgeCursorSessionSummary({
    event: 'run_end',
    hookPath: '/definitely/absent/orgx-session-summary.mjs',
  });
  assert.deepEqual(result, { ok: true, skipped: 'wizard_hook_unavailable' });
});
