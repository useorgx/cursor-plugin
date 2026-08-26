import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveSessionRuntimePaths } from './hydrate-context-pack.mjs';

const context = {
  schema_version: 'orgx-session-work-context/v1',
  provenance: 'producer_asserted',
  intent: {
    summary: 'Prove the direct Cursor sessionStart handoff.',
    acceptance_criteria: ['The first model request receives OrgX context'],
    constraints: [],
  },
  authority: {
    mode: 'unknown',
    status: 'unknown',
    scope: { actions: [], resources: [], systems: [] },
    constraints: [],
  },
  cost: { availability: 'not_observed' },
  artifact_refs: [],
  evidence_refs: [],
};

function runHook({ env, input }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [new URL('./hydrate-context-pack.mjs', import.meta.url).pathname],
      { env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('direct hook timed out'));
    }, 5_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolveResult({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input);
  });
}

test('direct sessionStart fetches, activates, stores privately, and injects the briefing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orgx-cursor-direct-e2e-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const projectDir = realpathSync(project);
  const sessionId = 'cursor-direct-e2e-session';
  const wizardLog = join(root, 'wizard-call.json');
  const wizardPath = join(root, 'fake-orgx-wizard.mjs');
  writeFileSync(
    wizardPath,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (process.env.ORGX_API_KEY || process.env.DATABASE_URL) process.exit(17);
JSON.parse(input);
writeFileSync(${JSON.stringify(wizardLog)}, JSON.stringify({ args }));
process.stdout.write(JSON.stringify({
  ackVersion: 'orgx-session-work-context-ack/v1',
  activationVersion: 'orgx-session-work-context-activation/v2',
  ready: true,
  state: 'ready',
  cwd: value('--cwd'),
  sourceClient: value('--source-client'),
  sessionId: value('--session-id'),
  contextSha256: value('--context-sha256')
}));
`,
    { mode: 0o700 }
  );
  chmodSync(wizardPath, 0o700);

  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: { sessionWorkContext: context } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const runtimeRoot = join(root, 'runtime');
  try {
    const result = await runHook({
      input: JSON.stringify({ cwd: projectDir, session_id: sessionId }),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        ORGX_TELEMETRY_DISABLED: '1',
        ORGX_API_KEY: 'test_api_key',
        DATABASE_URL: 'postgres://must:not@reach.invalid/db',
        ORGX_TASK_ID: 'task-direct-e2e',
        ORGX_BASE_URL: `http://127.0.0.1:${address.port}`,
        ORGX_CURSOR_CONTEXT_HOME: runtimeRoot,
        ORGX_WIZARD_BIN: wizardPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.match(output.additional_context, /wizard_validated/);
    assert.match(output.additional_context, /Prove the direct Cursor sessionStart/);
    assert.deepEqual(requests, [{
      url: '/api/v1/context-pack',
      authorization: 'Bearer test_api_key',
      body: JSON.stringify({ task_id: 'task-direct-e2e' }),
    }]);
    const wizardCall = JSON.parse(readFileSync(wizardLog, 'utf8'));
    assert.equal(wizardCall.args[2], 'set');
    assert.equal(wizardCall.args[wizardCall.args.indexOf('--cwd') + 1], projectDir);
    assert.equal(wizardCall.args[wizardCall.args.indexOf('--session-id') + 1], sessionId);
    const paths = resolveSessionRuntimePaths({
      projectDir,
      sessionId,
      env: { ORGX_CURSOR_CONTEXT_HOME: runtimeRoot },
    });
    assert.equal(existsSync(paths.packPath), true);
    assert.equal(existsSync(join(projectDir, '.cursor')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
