import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  MAX_ADDITIONAL_CONTEXT_BYTES,
  MAX_CONTEXT_PACK_RESPONSE_BYTES,
  MAX_HOOK_INPUT_BYTES,
  MAX_SESSION_WORK_CONTEXT_BYTES,
  PACK_FILENAME,
  PENDING_CONTEXT_FILENAME,
  SOURCE_CLIENT,
  WIZARD_ACK_VERSION,
  WIZARD_ACTIVATION_VERSION,
  activateSessionWorkContext,
  buildCursorSessionStartOutput,
  buildPackRequest,
  canonicalJson,
  clearSessionWorkContext,
  contextSha256,
  credentialFreeWizardEnvironment,
  isDirectRun,
  main,
  readBoundedJsonResponse,
  resolveConfig,
  resolveProjectDirectory,
  resolveSessionId,
  resolveSessionRuntimePaths,
} from "./hydrate-context-pack.mjs";

const SESSION_A = "cursor-session-a";
const SESSION_B = "cursor-session-b";
const sessionWorkContext = {
  schema_version: "orgx-session-work-context/v1",
  intent: {
    summary: "Continue the accepted Cursor implementation slice.",
    acceptance_criteria: ["Focused checks pass"],
    constraints: ["Do not invent authority"],
  },
  authority: {
    mode: "unknown",
    status: "unknown",
    scope: { actions: [], resources: [], systems: [] },
    constraints: [],
  },
  cost: { availability: "not_observed" },
  artifact_refs: [],
  evidence_refs: [],
  provenance: "producer_asserted",
};

function response(data, status = 200, envelope = { ok: true }) {
  const body = JSON.stringify({ ...envelope, data });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(Buffer.byteLength(body, "utf8")) },
    text: async () => body,
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function wizardAcknowledgement(args, overrides = {}) {
  const clear = args[2] === "clear";
  return {
    ackVersion: WIZARD_ACK_VERSION,
    ...(clear ? {} : { activationVersion: WIZARD_ACTIVATION_VERSION }),
    ready: !clear,
    state: clear ? "missing" : "ready",
    cwd: argValue(args, "--cwd"),
    sourceClient: argValue(args, "--source-client"),
    sessionId: argValue(args, "--session-id"),
    ...(clear
      ? { cleared: true }
      : { contextSha256: argValue(args, "--context-sha256") }),
    ...overrides,
  };
}

function wizardWithOutput(calls, outputFor) {
  return (command, args, options) => {
    const child = new EventEmitter();
    const chunks = [];
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    child.stdin.once("finish", () => {
      const call = {
        command,
        args,
        options,
        input: Buffer.concat(chunks).toString("utf8"),
      };
      calls.push(call);
      child.stdout.end(outputFor(call));
      setImmediate(() => child.emit("close", 0));
    });
    child.kill = () => undefined;
    return child;
  };
}

function successfulWizard(calls) {
  return wizardWithOutput(calls, ({ args }) =>
    JSON.stringify(wizardAcknowledgement(args))
  );
}

function fixture(prefix = "orgx-cursor-context-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projectDir = join(root, "project");
  mkdirSync(projectDir);
  return {
    root,
    projectDir: realpathSync(projectDir),
    env: {
      PATH: process.env.PATH,
      ORGX_TELEMETRY_DISABLED: "1",
      ORGX_CURSOR_CONTEXT_HOME: join(root, "runtime"),
      ORGX_API_KEY: "oxk_test",
      ORGX_TASK_ID: "task-1",
    },
  };
}

function hookInput(projectDir, sessionId = SESSION_A) {
  return JSON.stringify({ cwd: projectDir, session_id: sessionId });
}

test("sends the complete hierarchy to the canonical v1 endpoint", () => {
  const config = resolveConfig({
    ORGX_API_KEY: "oxk_test",
    ORGX_BASE_URL: "https://useorgx.com/",
    ORGX_WORKSPACE_ID: "workspace-1",
    ORGX_INITIATIVE_ID: "initiative-2",
    ORGX_WORKSTREAM_ID: "workstream-3",
    ORGX_TASK_ID: "task-4",
  });
  assert.deepEqual(config.anchor, { type: "task", id: "task-4" });
  assert.deepEqual(buildPackRequest(config), {
    url: "https://useorgx.com/api/v1/context-pack",
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oxk_test",
    },
    body: JSON.stringify({
      workspace_id: "workspace-1",
      initiative_id: "initiative-2",
      workstream_id: "workstream-3",
      task_id: "task-4",
    }),
  });
});

test("supports every exact hierarchy scope independently", () => {
  for (const [envKey, id, requestField, type] of [
    ["ORGX_WORKSPACE_ID", "workspace-1", "workspace_id", "workspace"],
    ["ORGX_INITIATIVE_ID", "initiative-1", "initiative_id", "initiative"],
    ["ORGX_WORKSTREAM_ID", "workstream-1", "workstream_id", "workstream"],
    ["ORGX_TASK_ID", "task-1", "task_id", "task"],
  ]) {
    const config = resolveConfig({ ORGX_API_KEY: "oxk_test", [envKey]: id });
    assert.deepEqual(config.anchor, { type, id });
    assert.deepEqual(JSON.parse(buildPackRequest(config).body), {
      [requestField]: id,
    });
  }
});

test("project config cannot provide credentials or redirect an environment key", () => {
  assert.equal(
    resolveConfig({}, {
      api_key: "repository_secret",
      base_url: "https://attacker.invalid",
      task_id: "task-local",
    }),
    null
  );
  const config = resolveConfig(
    { ORGX_API_KEY: "oxk_environment" },
    {
      api_key: "oxk_ignored",
      base_url: "https://attacker.invalid",
      task_id: "task-local",
    }
  );
  assert.equal(config.apiKey, "oxk_environment");
  assert.equal(config.baseUrl, "https://useorgx.com");
  assert.deepEqual(config.scope, { task_id: "task-local" });
});

test("rejects unsafe credential, query, path, and remote HTTP base URLs", () => {
  for (const baseUrl of [
    "http://api.example.test",
    "https://token@example.test",
    "https://api.example.test/path",
    "https://api.example.test?token=secret",
    "https://api.example.test/#fragment",
  ]) {
    assert.equal(
      resolveConfig({
        ORGX_API_KEY: "oxk_test",
        ORGX_BASE_URL: baseUrl,
        ORGX_TASK_ID: "task-1",
      }),
      null
    );
  }
  assert.equal(
    resolveConfig({
      ORGX_API_KEY: "oxk_test",
      ORGX_BASE_URL: "http://localhost:3000",
      ORGX_TASK_ID: "task-1",
    }).baseUrl,
    "http://localhost:3000"
  );
});

test("resolves only explicit Cursor project and bounded native session identity", () => {
  assert.equal(
    resolveProjectDirectory(
      { cwd: "/workspace/from-hook" },
      { CURSOR_PROJECT_DIR: "/workspace/from-env" }
    ),
    "/workspace/from-hook"
  );
  assert.equal(resolveProjectDirectory({}, {}, "relative/project"), undefined);
  assert.equal(resolveProjectDirectory({}, { CODEX_PROJECT_DIR: "/wrong" }), undefined);
  assert.equal(resolveSessionId({ session_id: SESSION_A }), SESSION_A);
  assert.equal(resolveSessionId({ conversationId: SESSION_B }), SESSION_B);
  assert.equal(resolveSessionId({ session_id: "x".repeat(513) }), undefined);
  assert.equal(resolveSessionId({ session_id: "unsafe\nvalue" }), undefined);
});

test("canonical context hashing sorts objects, preserves arrays, and omits undefined", () => {
  const first = {
    b: [{ z: 2, x: 1 }, 5, undefined],
    ignored: undefined,
    a: { d: 4, c: 3 },
  };
  const second = { a: { c: 3, d: 4 }, b: [{ x: 1, z: 2 }, 5] };
  const canonical = '{"a":{"c":3,"d":4},"b":[{"x":1,"z":2},5]}';
  assert.equal(canonicalJson(first), canonical);
  assert.equal(contextSha256(first), contextSha256(second));
  assert.equal(
    contextSha256(first),
    createHash("sha256").update(canonical, "utf8").digest("hex")
  );
  assert.notEqual(contextSha256(first), contextSha256({ ...second, b: [5] }));
});

test("activates v2 with exact cwd, source, session, hash, and credential-free env", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  try {
    const result = await activateSessionWorkContext({
      context: sessionWorkContext,
      projectDir,
      sessionId: SESSION_A,
      env: {
        ...env,
        ORGX_GATEWAY_KEY: "must_not_reach_wizard",
        DATABASE_URL: "postgres://must:not@reach.invalid/db",
      },
      spawnImpl: successfulWizard(calls),
    });
    assert.deepEqual(result, { activated: true, reason: "wizard_activated" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "sessions",
      "context",
      "set",
      "--file",
      "-",
      "--cwd",
      projectDir,
      "--source-client",
      SOURCE_CLIENT,
      "--session-id",
      SESSION_A,
      "--context-sha256",
      contextSha256(sessionWorkContext),
      "--json",
    ]);
    assert.deepEqual(JSON.parse(calls[0].input), sessionWorkContext);
    assert.equal(calls[0].options.env.ORGX_API_KEY, undefined);
    assert.equal(calls[0].options.env.ORGX_GATEWAY_KEY, undefined);
    assert.equal(calls[0].options.env.DATABASE_URL, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wizard commands canonicalize a symlinked project cwd before binding authority", async () => {
  const { root, projectDir, env } = fixture();
  const projectAlias = join(root, "project-alias");
  symlinkSync(projectDir, projectAlias);
  const calls = [];
  try {
    const result = await activateSessionWorkContext({
      context: sessionWorkContext,
      projectDir: projectAlias,
      sessionId: SESSION_A,
      env,
      spawnImpl: successfulWizard(calls),
    });
    assert.equal(result.activated, true);
    assert.equal(argValue(calls[0].args, "--cwd"), projectDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects minimal, wrong-version, wrong-session, and hash-mismatch set acks", async () => {
  const { root, projectDir, env } = fixture();
  const hash = contextSha256(sessionWorkContext);
  const base = {
    ackVersion: WIZARD_ACK_VERSION,
    activationVersion: WIZARD_ACTIVATION_VERSION,
    ready: true,
    state: "ready",
    cwd: projectDir,
    sourceClient: SOURCE_CLIENT,
    sessionId: SESSION_A,
    contextSha256: hash,
  };
  try {
    for (const output of [
      { ready: true, state: "ready", cwd: projectDir },
      { ...base, ackVersion: "wrong" },
      { ...base, activationVersion: "wrong" },
      { ...base, sessionId: SESSION_B },
      { ...base, contextSha256: "0".repeat(64) },
      { ...base, contextSha256: hash.toUpperCase() },
    ]) {
      const result = await activateSessionWorkContext({
        context: sessionWorkContext,
        projectDir,
        sessionId: SESSION_A,
        env,
        spawnImpl: wizardWithOutput([], () => JSON.stringify(output)),
      });
      assert.deepEqual(result, {
        activated: false,
        reason: "wizard_ack_mismatch",
      });
    }
    const malformed = await activateSessionWorkContext({
      context: sessionWorkContext,
      projectDir,
      sessionId: SESSION_A,
      env,
      spawnImpl: wizardWithOutput([], () => "not-json"),
    });
    assert.deepEqual(malformed, {
      activated: false,
      reason: "wizard_unverified",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear requires exact v2 ack identity and missing state", async () => {
  const { root, projectDir, env } = fixture();
  try {
    const calls = [];
    const cleared = await clearSessionWorkContext({
      projectDir,
      sessionId: SESSION_A,
      env,
      spawnImpl: successfulWizard(calls),
    });
    assert.deepEqual(cleared, { cleared: true, reason: "wizard_cleared" });
    assert.deepEqual(calls[0].args, [
      "sessions",
      "context",
      "clear",
      "--cwd",
      projectDir,
      "--source-client",
      SOURCE_CLIENT,
      "--session-id",
      SESSION_A,
      "--json",
    ]);

    for (const override of [
      { ackVersion: undefined },
      { cwd: `${projectDir}-other` },
      { sourceClient: "codex" },
      { sessionId: SESSION_B },
      { ready: true },
      { state: "ready" },
    ]) {
      const result = await clearSessionWorkContext({
        projectDir,
        sessionId: SESSION_A,
        env,
        spawnImpl: wizardWithOutput([], ({ args }) =>
          JSON.stringify(wizardAcknowledgement(args, override))
        ),
      });
      assert.deepEqual(result, {
        cleared: false,
        reason: "wizard_ack_mismatch",
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hydrates private per-session state and emits bounded first-turn context", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  const requests = [];
  const now = new Date("2026-08-24T20:00:00.000Z");
  try {
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return response({ frame: { anchor: "task-1" }, sessionWorkContext });
      },
      spawnImpl: successfulWizard(calls),
      now,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.session_context, {
      activated: true,
      reason: "wizard_activated",
      source_client: SOURCE_CLIENT,
      session_id: SESSION_A,
      context_sha256: contextSha256(sessionWorkContext),
    });
    assert.equal(requests[0].url, "https://useorgx.com/api/v1/context-pack");
    assert.equal(requests[0].options.redirect, "error");
    const paths = resolveSessionRuntimePaths({
      projectDir,
      sessionId: SESSION_A,
      env,
    });
    assert.equal(result.context_pack_path, paths.packPath);
    assert.deepEqual(JSON.parse(readFileSync(paths.packPath, "utf8")), {
      fetchedAt: now.toISOString(),
      data: { frame: { anchor: "task-1" }, sessionWorkContext },
    });
    assert.equal(statSync(paths.packPath).mode & 0o777, 0o600);
    assert.equal(statSync(paths.directory).mode & 0o777, 0o700);
    assert.equal(existsSync(paths.pendingPath), false);
    assert.equal(existsSync(join(projectDir, ".cursor", PACK_FILENAME)), false);

    const output = buildCursorSessionStartOutput(result);
    assert.equal(typeof output.additional_context, "string");
    assert.match(output.additional_context, /wizard_validated/);
    assert.match(output.additional_context, /Continue the accepted Cursor/);
    assert.ok(
      Buffer.byteLength(output.additional_context, "utf8") <=
        MAX_ADDITIONAL_CONTEXT_BYTES
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two native sessions in one cwd get independent runtime state and leases", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  try {
    const [first, second] = await Promise.all(
      [SESSION_A, SESSION_B].map((sessionId) =>
        main({
          env,
          stdinText: hookInput(projectDir, sessionId),
          fetchImpl: async () => response({ sessionWorkContext }),
          spawnImpl: successfulWizard(calls),
        })
      )
    );
    assert.notEqual(first.context_pack_path, second.context_pack_path);
    assert.equal(existsSync(first.context_pack_path), true);
    assert.equal(existsSync(second.context_pack_path), true);
    const setCalls = calls.filter((call) => call.args[2] === "set");
    assert.deepEqual(
      new Set(setCalls.map((call) => argValue(call.args, "--session-id"))),
      new Set([SESSION_A, SESSION_B])
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime state remains invisible to git", async () => {
  const { root, projectDir, env } = fixture("orgx-cursor-git-");
  try {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: projectDir,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({ sessionWorkContext }),
      spawnImpl: successfulWizard([]),
    });
    assert.equal(result.session_context.activated, true);
    const status = spawnSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: projectDir, encoding: "utf8" }
    );
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked .cursor parent cannot redirect runtime writes", async () => {
  const { root, projectDir, env } = fixture("orgx-cursor-parent-link-");
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "marker"), "unchanged");
  symlinkSync(outside, join(projectDir, ".cursor"));
  try {
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({ sessionWorkContext }),
      spawnImpl: successfulWizard([]),
    });
    assert.equal(result.session_context.activated, true);
    assert.deepEqual(readdirSync(outside), ["marker"]);
    assert.equal(readFileSync(join(outside, "marker"), "utf8"), "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked private session directory is rejected without target writes", async () => {
  const { root, projectDir, env } = fixture("orgx-cursor-runtime-link-");
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "marker"), "unchanged");
  const paths = resolveSessionRuntimePaths({ projectDir, sessionId: SESSION_A, env });
  mkdirSync(paths.root, { recursive: true });
  symlinkSync(outside, paths.directory);
  const calls = [];
  try {
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({ sessionWorkContext }),
      spawnImpl: successfulWizard(calls),
    });
    assert.equal(result.skipped, "context_pack_hydration_failed");
    assert.equal(result.session_context.prior_activation_cleared, true);
    assert.deepEqual(readdirSync(outside), ["marker"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], "clear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic replacement never follows a symlinked runtime leaf", async () => {
  const { root, projectDir, env } = fixture("orgx-cursor-leaf-link-");
  const target = join(root, "protected.json");
  writeFileSync(target, '{"protected":true}\n', { mode: 0o600 });
  const paths = resolveSessionRuntimePaths({ projectDir, sessionId: SESSION_A, env });
  mkdirSync(paths.directory, { recursive: true });
  symlinkSync(target, paths.packPath);
  try {
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({ sessionWorkContext }),
      spawnImpl: successfulWizard([]),
    });
    assert.equal(result.session_context.activated, true);
    assert.equal(readFileSync(target, "utf8"), '{"protected":true}\n');
    assert.equal(
      JSON.parse(readFileSync(paths.packPath, "utf8")).data.sessionWorkContext.intent.summary,
      sessionWorkContext.intent.summary
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid set acknowledgement is cleared and retained only as pending briefing", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  const spawnImpl = wizardWithOutput(calls, ({ args }) =>
    JSON.stringify(
      args[2] === "set"
        ? { ready: true, state: "ready", cwd: projectDir }
        : wizardAcknowledgement(args)
    )
  );
  try {
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({ sessionWorkContext }),
      spawnImpl,
    });
    assert.equal(result.session_context.activated, false);
    assert.equal(result.session_context.reason, "wizard_ack_mismatch");
    assert.equal(result.session_context.prior_activation_cleared, true);
    assert.deepEqual(calls.map((call) => call.args[2]), ["set", "clear"]);
    assert.deepEqual(
      JSON.parse(readFileSync(result.session_context.pending_path, "utf8")),
      sessionWorkContext
    );
    const output = buildCursorSessionStartOutput(result);
    assert.match(output.additional_context, /informational only/);
    assert.match(output.additional_context, /"authority":"not_active"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline refresh clears the prior exact-session authority and private state", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  const leases = new Set();
  const key = `${projectDir}:${SESSION_A}`;
  const spawnImpl = wizardWithOutput(calls, ({ args }) => {
    const lease = `${argValue(args, "--cwd")}:${argValue(args, "--session-id")}`;
    if (args[2] === "set") leases.add(lease);
    else leases.delete(lease);
    return JSON.stringify(wizardAcknowledgement(args));
  });
  try {
    const first = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({ sessionWorkContext }),
      spawnImpl,
    });
    assert.equal(first.session_context.activated, true);
    assert.equal(leases.has(key), true);
    assert.equal(existsSync(first.context_pack_path), true);

    const second = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => {
        throw new TypeError("offline");
      },
      spawnImpl,
    });
    assert.equal(second.skipped, "context_pack_request_failed");
    assert.equal(second.reason, "network_error");
    assert.equal(second.session_context.prior_activation_cleared, true);
    assert.equal(leases.has(key), false);
    assert.equal(existsSync(first.context_pack_path), false);
    assert.deepEqual(calls.map((call) => call.args[2]), ["set", "clear"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unverified success envelope clears rather than preserving stale authority", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  try {
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({}, 200, { ok: false }),
      spawnImpl: successfulWizard(calls),
    });
    assert.equal(result.skipped, "context_pack_response_invalid");
    assert.equal(result.reason, "envelope_unverified");
    assert.equal(result.session_context.prior_activation_cleared, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], "clear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("definitive empty or invalid context clears the exact session", async () => {
  for (const [data, expectedReason] of [
    [{ contextCapsule: { workspaceId: "workspace-1" } }, "not_returned"],
    [{ sessionWorkContext: { schema_version: "wrong" } }, "context_invalid"],
  ]) {
    const { root, projectDir, env } = fixture();
    const calls = [];
    try {
      const result = await main({
        env,
        stdinText: hookInput(projectDir),
        fetchImpl: async () => response(data),
        spawnImpl: successfulWizard(calls),
      });
      assert.equal(result.session_context.reason, expectedReason);
      assert.equal(result.session_context.prior_activation_cleared, true);
      assert.equal(argValue(calls[0].args, "--session-id"), SESSION_A);
      assert.equal(calls[0].args[2], "clear");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("oversized session context is never activated or retained pending", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  const oversized = {
    ...sessionWorkContext,
    intent: {
      ...sessionWorkContext.intent,
      summary: "x".repeat(MAX_SESSION_WORK_CONTEXT_BYTES),
    },
  };
  try {
    const result = await main({
      env,
      stdinText: hookInput(projectDir),
      fetchImpl: async () => response({ sessionWorkContext: oversized }),
      spawnImpl: successfulWizard(calls),
    });
    assert.equal(result.session_context.reason, "context_invalid");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], "clear");
    const paths = resolveSessionRuntimePaths({ projectDir, sessionId: SESSION_A, env });
    assert.equal(existsSync(paths.pendingPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds hook input, response bodies, and Wizard acknowledgements", async () => {
  let fetched = false;
  const oversizedHook = await main({
    env: { ORGX_API_KEY: "oxk_test", ORGX_TASK_ID: "task-1" },
    stdinText: JSON.stringify({
      cwd: "/workspace/untrusted",
      session_id: SESSION_A,
      padding: "x".repeat(MAX_HOOK_INPUT_BYTES),
    }),
    fetchImpl: async () => {
      fetched = true;
      return response({});
    },
  });
  assert.equal(oversizedHook.skipped, "project_directory_unavailable");
  assert.equal(fetched, false);

  const declared = await readBoundedJsonResponse({
    headers: { get: () => String(MAX_CONTEXT_PACK_RESPONSE_BYTES + 1) },
    text: async () => {
      throw new Error("must reject before reading");
    },
  });
  assert.deepEqual(declared, { ok: false, reason: "response_too_large" });
  const undeclaredBody = JSON.stringify({
    ok: true,
    data: { padding: "x".repeat(MAX_CONTEXT_PACK_RESPONSE_BYTES) },
  });
  const undeclared = await readBoundedJsonResponse({
    headers: { get: () => null },
    text: async () => undeclaredBody,
  });
  assert.deepEqual(undeclared, { ok: false, reason: "response_too_large" });

  const { root, projectDir, env } = fixture();
  try {
    const wizard = await activateSessionWorkContext({
      context: sessionWorkContext,
      projectDir,
      sessionId: SESSION_A,
      env,
      spawnImpl: wizardWithOutput([], () => "x".repeat(20 * 1024)),
    });
    assert.deepEqual(wizard, {
      activated: false,
      reason: "wizard_output_too_large",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stalled response times out and clears exact-session authority", async () => {
  const { root, projectDir, env } = fixture();
  const calls = [];
  const startedAt = Date.now();
  try {
    const result = await main({
      env: { ...env, ORGX_CONTEXT_PACK_TIMEOUT_MS: "250" },
      stdinText: hookInput(projectDir),
      fetchImpl: async (_url, options) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () =>
              new Promise((_resolve, reject) => {
                const rejectAbort = () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                };
                if (options.signal.aborted) rejectAbort();
                else options.signal.addEventListener("abort", rejectAbort, { once: true });
              }),
          }),
        },
      }),
      spawnImpl: successfulWizard(calls),
    });
    assert.equal(result.reason, "timeout");
    assert.equal(result.session_context.prior_activation_cleared, true);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct hook stdout is one parseable bounded additional_context response", () => {
  const { root, projectDir, env } = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [new URL("./hydrate-context-pack.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        input: hookInput(projectDir),
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          ORGX_CURSOR_CONTEXT_HOME: env.ORGX_CURSOR_CONTEXT_HOME,
          ORGX_WIZARD_BIN: join(root, "missing-orgx-wizard"),
          ORGX_TELEMETRY_DISABLED: "1",
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    const output = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(output), ["additional_context"]);
    assert.match(output.additional_context, /No OrgX authority|did not activate authority/);
    assert.ok(
      Buffer.byteLength(output.additional_context, "utf8") <=
        MAX_ADDITIONAL_CONTEXT_BYTES
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects direct execution across filesystem path aliases", () => {
  assert.equal(
    isDirectRun({
      argvPath: "/tmp/orgx/hydrate-context-pack.mjs",
      moduleUrl: "file:///private/tmp/orgx/hydrate-context-pack.mjs",
      realpathSyncImpl: (path) => path.replace(/^\/tmp\//, "/private/tmp/"),
    }),
    true
  );
});

test(
  "real Wizard v2 activates and clears the exact Cursor session lease",
  { skip: process.env.ORGX_RUN_WIZARD_V2_INTEGRATION !== "1" },
  async () => {
    const { root, projectDir, env } = fixture("orgx-cursor-wizard-v2-");
    const wizardEnv = {
      ...env,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      ORGX_WIZARD_BIN: process.env.ORGX_WIZARD_BIN,
    };
    try {
      const activation = await activateSessionWorkContext({
        context: sessionWorkContext,
        projectDir,
        sessionId: SESSION_A,
        env: wizardEnv,
      });
      assert.deepEqual(activation, {
        activated: true,
        reason: "wizard_activated",
      });
      const cleared = await clearSessionWorkContext({
        projectDir,
        sessionId: SESSION_A,
        env: wizardEnv,
      });
      assert.deepEqual(cleared, { cleared: true, reason: "wizard_cleared" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
