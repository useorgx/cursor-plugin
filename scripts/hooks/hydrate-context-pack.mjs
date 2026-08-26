#!/usr/bin/env node
/**
 * SessionStart: hydrate accepted OrgX context into one native Cursor session.
 *
 * OrgX compiles the briefing and the Wizard validates a short-lived,
 * exact-session authority lease. This adapter keeps only bounded private
 * runtime state outside the repository and returns Cursor's documented
 * `additional_context` payload on stdout.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import { captureCursorHookException } from "./sentry.mjs";
import {
  PACK_FILENAME,
  PENDING_CONTEXT_FILENAME,
  SOURCE_CLIENT,
  canonicalJson,
  contextSha256,
  isPathWithin,
  persistPendingSessionWorkContext,
  privateRuntimeJsonWrite,
  removePendingContext,
  removeSessionRuntimeState,
  resolveSessionRuntimePaths,
} from "./cursor-context-runtime.mjs";

export {
  PACK_FILENAME,
  PENDING_CONTEXT_FILENAME,
  SOURCE_CLIENT,
  canonicalJson,
  contextSha256,
  persistPendingSessionWorkContext,
  removeSessionRuntimeState,
  resolveSessionRuntimePaths,
} from "./cursor-context-runtime.mjs";
export const MAX_HOOK_INPUT_BYTES = 64 * 1024;
export const MAX_CONTEXT_PACK_RESPONSE_BYTES = 128 * 1024;
export const MAX_SESSION_WORK_CONTEXT_BYTES = 4 * 1024;
export const MAX_ADDITIONAL_CONTEXT_BYTES = 8 * 1024;
export const WIZARD_ACK_VERSION = "orgx-session-work-context-ack/v1";
export const WIZARD_ACTIVATION_VERSION =
  "orgx-session-work-context-activation/v2";

const MAX_LOCAL_CONFIG_BYTES = 16 * 1024;
const MAX_WIZARD_OUTPUT_BYTES = 16 * 1024;
const MAX_SESSION_ID_CHARACTERS = 500;
const DEFAULT_TIMEOUT_MS = 3_000;
const LOCAL_CONFIG_PATHS = [
  [".cursor", "orgx.local.json"],
  [".claude", "orgx.local.json"],
];
const WIZARD_ENV_ALLOWLIST = new Set([
  "APPDATA",
  "CI",
  "ComSpec",
  "DO_NOT_TRACK",
  "DSH_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "ORGX_TELEMETRY_DISABLED",
  "ORGX_WIZARD_CONFIG_HOME",
  "ORGX_WIZARD_DISABLE_KEYTAR",
  "ORGX_WIZARD_HOOK_OUTBOX",
  "ORGX_WIZARD_HOOK_OUTBOX_MAX_BYTES",
  "ORGX_WIZARD_HOOK_SPOOL",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const SCOPE_FIELDS = [
  {
    name: "workspace",
    requestField: "workspace_id",
    env: "ORGX_WORKSPACE_ID",
    local: ["workspaceId", "workspace_id"],
  },
  {
    name: "initiative",
    requestField: "initiative_id",
    env: "ORGX_INITIATIVE_ID",
    local: ["initiativeId", "initiative_id"],
  },
  {
    name: "workstream",
    requestField: "workstream_id",
    env: "ORGX_WORKSTREAM_ID",
    local: ["workstreamId", "workstream_id"],
  },
  {
    name: "task",
    requestField: "task_id",
    env: "ORGX_TASK_ID",
    local: ["taskId", "task_id"],
  },
];
const ANCHOR_PRIORITY = ["task", "workstream", "initiative", "workspace"];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isLowercaseSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseHookPayload(stdinText = "") {
  if (Buffer.byteLength(stdinText, "utf8") > MAX_HOOK_INPUT_BYTES) return {};
  try {
    const value = JSON.parse(stdinText || "{}");
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export async function readStdin(
  stream = process.stdin,
  maxBytes = MAX_HOOK_INPUT_BYTES
) {
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (!overflow && bytes <= maxBytes) chunks.push(buffer);
    else overflow = true;
  }
  return overflow ? "" : Buffer.concat(chunks).toString("utf8");
}

/** Plugin hooks run from the plugin cwd, so only hook/project signals count. */
export function resolveProjectDirectory(payload = {}, env = {}, explicit) {
  const candidate = pickString(
    explicit,
    payload.cwd,
    payload.working_directory,
    payload.workspace,
    ...(Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []),
    ...(Array.isArray(payload.workspaceRoots) ? payload.workspaceRoots : []),
    env.CURSOR_PROJECT_DIR
  );
  return candidate && isAbsolute(candidate) ? resolve(candidate) : undefined;
}

export function resolveCanonicalProjectDirectory(payload = {}, env = {}, explicit) {
  const candidate = resolveProjectDirectory(payload, env, explicit);
  if (!candidate || !existsSync(candidate)) return undefined;
  try {
    if (!statSync(candidate).isDirectory()) return undefined;
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

export function resolveSessionId(payload = {}, explicit) {
  const sessionId = pickString(
    explicit,
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId
  );
  if (
    !sessionId ||
    sessionId.length > MAX_SESSION_ID_CHARACTERS ||
    /[\0\r\n]/.test(sessionId)
  ) {
    return undefined;
  }
  return sessionId;
}

function safeOptionalConfigPath(projectDir, parts) {
  const parent = join(projectDir, parts[0]);
  try {
    if (lstatSync(parent).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  return join(projectDir, ...parts);
}

export function readLocalConfig(projectDir) {
  for (const parts of LOCAL_CONFIG_PATHS) {
    const path = safeOptionalConfigPath(projectDir, parts);
    if (!path || !existsSync(path)) continue;
    try {
      if (statSync(path).size > MAX_LOCAL_CONFIG_BYTES) continue;
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(value)) return value;
    } catch {
      // A malformed optional local config must not block session startup.
    }
  }
  return null;
}

function localValue(localConfig, keys) {
  return isRecord(localConfig)
    ? pickString(...keys.map((key) => localConfig[key]))
    : undefined;
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === "http:" &&
      ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.pathname !== "/") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Credentials and a non-default origin may only come from the environment. */
export function resolveConfig(env = {}, localConfig = null) {
  const apiKey = pickString(env.ORGX_API_KEY);
  if (!apiKey) return null;

  const configuredBaseUrl = pickString(env.ORGX_BASE_URL);
  const baseUrl = safeBaseUrl(configuredBaseUrl || "https://useorgx.com");
  if (!baseUrl) return null;

  const scope = {};
  for (const field of SCOPE_FIELDS) {
    const id = pickString(env[field.env], localValue(localConfig, field.local));
    if (id) scope[field.requestField] = id;
  }
  if (Object.keys(scope).length === 0) return null;

  const anchorName = ANCHOR_PRIORITY.find((name) => {
    const field = SCOPE_FIELDS.find((candidate) => candidate.name === name);
    return field && scope[field.requestField];
  });
  const anchorField = SCOPE_FIELDS.find((field) => field.name === anchorName);
  return {
    apiKey,
    baseUrl,
    scope,
    anchor: anchorField
      ? { type: anchorField.name, id: scope[anchorField.requestField] }
      : null,
  };
}

export function buildPackRequest(config) {
  return {
    url: `${config.baseUrl}/api/v1/context-pack`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(config.scope),
  };
}

async function readResponseText(response, maxBytes) {
  const declaredLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: "response_too_large" };
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "response_too_large" };
      }
      chunks.push(chunk);
    }
    return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
  }

  if (typeof response?.text !== "function") {
    return { ok: false, reason: "response_body_unavailable" };
  }
  const text = await response.text();
  return Buffer.byteLength(text, "utf8") <= maxBytes
    ? { ok: true, text }
    : { ok: false, reason: "response_too_large" };
}

export async function readBoundedJsonResponse(
  response,
  maxBytes = MAX_CONTEXT_PACK_RESPONSE_BYTES
) {
  const body = await readResponseText(response, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, reason: "response_invalid_json" };
  }
}

function timeoutFromEnvironment(env, key) {
  const configured = Number(env[key]);
  return Number.isFinite(configured) && configured >= 250 && configured <= 10_000
    ? Math.round(configured)
    : DEFAULT_TIMEOUT_MS;
}

export function credentialFreeWizardEnvironment(env = process.env) {
  const childEnv = {};
  for (const name of WIZARD_ENV_ALLOWLIST) {
    if (typeof env[name] === "string") childEnv[name] = env[name];
  }
  return childEnv;
}

export function isDirectRun({
  argvPath = process.argv[1],
  moduleUrl = import.meta.url,
  realpathSyncImpl = realpathSync,
} = {}) {
  if (!argvPath) return false;
  try {
    return realpathSyncImpl(argvPath) === realpathSyncImpl(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

function commonAcknowledgementMatches(value, expected) {
  return (
    isRecord(value) &&
    value.ackVersion === WIZARD_ACK_VERSION &&
    value.cwd === expected.projectDir &&
    value.sourceClient === SOURCE_CLIENT &&
    value.sessionId === expected.sessionId
  );
}

function parseWizardAcknowledgement(stdout, expected) {
  try {
    const value = JSON.parse(stdout);
    if (!commonAcknowledgementMatches(value, expected)) {
      return { activated: false, reason: "wizard_ack_mismatch" };
    }
    if (
      value.activationVersion !== WIZARD_ACTIVATION_VERSION ||
      value.ready !== true ||
      value.state !== "ready" ||
      value.contextSha256 !== expected.contextSha256 ||
      !isLowercaseSha256(value.contextSha256)
    ) {
      return { activated: false, reason: "wizard_ack_mismatch" };
    }
    return { activated: true, reason: "wizard_activated" };
  } catch {
    return { activated: false, reason: "wizard_unverified" };
  }
}

function parseWizardClearAcknowledgement(stdout, expected) {
  try {
    const value = JSON.parse(stdout);
    if (!commonAcknowledgementMatches(value, expected)) {
      return { cleared: false, reason: "wizard_ack_mismatch" };
    }
    if (value.ready !== false || value.state !== "missing") {
      return { cleared: false, reason: "wizard_ack_mismatch" };
    }
    return {
      cleared: true,
      reason: value.cleared === true ? "wizard_cleared" : "wizard_already_clear",
    };
  } catch {
    return { cleared: false, reason: "wizard_unverified" };
  }
}

function runWizardJsonCommand({
  args,
  input = "",
  operation = "activate",
  expected,
  env,
  spawnImpl,
  parseSuccess,
}) {
  return new Promise((resolveResult) => {
    let child;
    let settled = false;
    let outputBytes = 0;
    const output = [];
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    const failure = (reason) =>
      operation === "clear"
        ? { cleared: false, reason }
        : { activated: false, reason };

    try {
      child = spawnImpl(pickString(env.ORGX_WIZARD_BIN) || "orgx-wizard", args, {
        env: credentialFreeWizardEnvironment(env),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish(failure("wizard_unavailable"));
      return;
    }

    child.once?.("error", () => finish(failure("wizard_unavailable")));
    child.stdout?.on?.("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > MAX_WIZARD_OUTPUT_BYTES) {
        child.kill?.();
        finish(failure("wizard_output_too_large"));
        return;
      }
      output.push(buffer);
    });
    child.once?.("close", (code) => {
      if (code !== 0) {
        finish(failure("wizard_rejected"));
        return;
      }
      finish(parseSuccess(Buffer.concat(output).toString("utf8"), expected));
    });
    child.stdin?.once?.("error", () => finish(failure("wizard_unavailable")));
    timer = setTimeout(() => {
      child.kill?.();
      finish(failure("wizard_timeout"));
    }, timeoutFromEnvironment(env, "ORGX_SESSION_CONTEXT_ACTIVATION_TIMEOUT_MS"));

    try {
      child.stdin?.end(input);
    } catch {
      finish(failure("wizard_unavailable"));
    }
  });
}

/** Forward the exact server object with its canonical digest to Wizard v2. */
export async function activateSessionWorkContext({
  context,
  projectDir,
  sessionId,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const activeProjectDir = resolveCanonicalProjectDirectory({}, {}, projectDir);
  const activeSessionId = resolveSessionId({}, sessionId);
  if (
    !isRecord(context) ||
    context.schema_version !== "orgx-session-work-context/v1" ||
    jsonBytes(context) > MAX_SESSION_WORK_CONTEXT_BYTES ||
    !activeProjectDir ||
    !activeSessionId
  ) {
    return { activated: false, reason: "context_invalid" };
  }

  const contextHash = contextSha256(context);
  const expected = {
    projectDir: activeProjectDir,
    sessionId: activeSessionId,
    contextSha256: contextHash,
  };
  return runWizardJsonCommand({
    args: [
      "sessions",
      "context",
      "set",
      "--file",
      "-",
      "--cwd",
      activeProjectDir,
      "--source-client",
      SOURCE_CLIENT,
      "--session-id",
      activeSessionId,
      "--context-sha256",
      contextHash,
      "--json",
    ],
    input: JSON.stringify(context),
    expected,
    env,
    spawnImpl,
    parseSuccess: parseWizardAcknowledgement,
  });
}

/** Clear only this native Cursor session's exact Wizard lease. */
export async function clearSessionWorkContext({
  projectDir,
  sessionId,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const activeProjectDir = resolveCanonicalProjectDirectory({}, {}, projectDir);
  const activeSessionId = resolveSessionId({}, sessionId);
  if (!activeProjectDir || !activeSessionId) {
    return { cleared: false, reason: "session_identity_unavailable" };
  }
  const expected = { projectDir: activeProjectDir, sessionId: activeSessionId };
  return runWizardJsonCommand({
    args: [
      "sessions",
      "context",
      "clear",
      "--cwd",
      activeProjectDir,
      "--source-client",
      SOURCE_CLIENT,
      "--session-id",
      activeSessionId,
      "--json",
    ],
    operation: "clear",
    expected,
    env,
    spawnImpl,
    parseSuccess: parseWizardClearAcknowledgement,
  });
}

async function clearFailureState({
  projectDir,
  sessionId,
  env,
  spawnImpl,
  skipped,
  reason,
  status,
}) {
  const clearance = await clearSessionWorkContext({
    projectDir,
    sessionId,
    env,
    spawnImpl,
  });
  removeSessionRuntimeState({ projectDir, sessionId, env });
  return {
    ok: true,
    skipped,
    ...(reason ? { reason } : {}),
    ...(status !== undefined ? { status } : {}),
    session_context: {
      activated: false,
      reason: skipped,
      source_client: SOURCE_CLIENT,
      session_id: sessionId,
      prior_activation_cleared: clearance.cleared,
      clear_reason: clearance.reason,
    },
  };
}

export async function main({
  env = process.env,
  stdinText = "",
  projectDir,
  sessionId,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  now = new Date(),
} = {}) {
  let activeProjectDir;
  let activeSessionId;
  try {
    const payload = parseHookPayload(stdinText);
    activeProjectDir = resolveCanonicalProjectDirectory(payload, env, projectDir);
    if (!activeProjectDir) {
      return { ok: true, skipped: "project_directory_unavailable" };
    }
    activeSessionId = resolveSessionId(payload, sessionId);
    if (!activeSessionId) {
      return { ok: true, skipped: "session_identity_unavailable" };
    }

    const runtimePaths = resolveSessionRuntimePaths({
      projectDir: activeProjectDir,
      sessionId: activeSessionId,
      env,
    });
    if (!runtimePaths || isPathWithin(activeProjectDir, runtimePaths.root)) {
      return await clearFailureState({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
        spawnImpl,
        skipped: "runtime_storage_unsafe",
      });
    }

    const config = resolveConfig(env, readLocalConfig(activeProjectDir));
    if (!config) {
      return await clearFailureState({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
        spawnImpl,
        skipped: "context_pack_unconfigured",
      });
    }

    const request = buildPackRequest(config);
    const controller = new AbortController();
    const requestTimer = setTimeout(
      () => controller.abort(),
      timeoutFromEnvironment(env, "ORGX_CONTEXT_PACK_TIMEOUT_MS")
    );
    let response;
    let parsed;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "error",
        signal: controller.signal,
      });
      if (response?.ok) parsed = await readBoundedJsonResponse(response);
    } catch (error) {
      return await clearFailureState({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
        spawnImpl,
        skipped: "context_pack_request_failed",
        reason: error?.name === "AbortError" ? "timeout" : "network_error",
      });
    } finally {
      clearTimeout(requestTimer);
    }
    if (!response?.ok) {
      return await clearFailureState({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
        spawnImpl,
        skipped: "context_pack_request_failed",
        status: response?.status,
      });
    }

    if (!parsed.ok || parsed.value?.ok !== true || !isRecord(parsed.value?.data)) {
      return await clearFailureState({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
        spawnImpl,
        skipped: "context_pack_response_invalid",
        reason:
          parsed.reason ||
          (parsed.value?.ok !== true ? "envelope_unverified" : "data_missing"),
      });
    }

    const data = parsed.value.data;
    const context = data.sessionWorkContext;
    const contextValid =
      isRecord(context) &&
      context.schema_version === "orgx-session-work-context/v1" &&
      jsonBytes(context) <= MAX_SESSION_WORK_CONTEXT_BYTES;
    const retainedData = contextValid
      ? data
      : Object.fromEntries(
          Object.entries(data).filter(([key]) => key !== "sessionWorkContext")
        );
    const contextPackPath = privateRuntimeJsonWrite(
      runtimePaths,
      activeProjectDir,
      runtimePaths.packPath,
      { fetchedAt: now.toISOString(), data: retainedData }
    );
    if (!contextValid) {
      removePendingContext(runtimePaths);
      const clearance = await clearSessionWorkContext({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
        spawnImpl,
      });
      return {
        ok: true,
        context_pack_path: contextPackPath,
        session_context: {
          activated: false,
          reason: isRecord(context) ? "context_invalid" : "not_returned",
          source_client: SOURCE_CLIENT,
          session_id: activeSessionId,
          prior_activation_cleared: clearance.cleared,
          clear_reason: clearance.reason,
        },
      };
    }

    const contextHash = contextSha256(context);
    const activation = await activateSessionWorkContext({
      context,
      projectDir: activeProjectDir,
      sessionId: activeSessionId,
      env,
      spawnImpl,
    });
    if (activation.activated) {
      removePendingContext(runtimePaths);
      return {
        ok: true,
        context_pack_path: contextPackPath,
        session_work_context: context,
        session_context: {
          ...activation,
          source_client: SOURCE_CLIENT,
          session_id: activeSessionId,
          context_sha256: contextHash,
        },
      };
    }

    const clearance = await clearSessionWorkContext({
      projectDir: activeProjectDir,
      sessionId: activeSessionId,
      env,
      spawnImpl,
    });
    const pendingPath = persistPendingSessionWorkContext(
      runtimePaths,
      activeProjectDir,
      context
    );
    return {
      ok: true,
      context_pack_path: contextPackPath,
      session_work_context: context,
      session_context: {
        ...activation,
        source_client: SOURCE_CLIENT,
        session_id: activeSessionId,
        context_sha256: contextHash,
        prior_activation_cleared: clearance.cleared,
        clear_reason: clearance.reason,
        pending_path: pendingPath,
      },
    };
  } catch (error) {
    let clearance;
    if (activeProjectDir && activeSessionId) {
      clearance = await clearSessionWorkContext({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
        spawnImpl,
      });
      removeSessionRuntimeState({
        projectDir: activeProjectDir,
        sessionId: activeSessionId,
        env,
      });
    }
    await captureCursorHookException(
      error,
      { hook: "hydrate-context-pack" },
      { env }
    );
    return {
      ok: true,
      skipped: "context_pack_hydration_failed",
      ...(activeSessionId
        ? {
            session_context: {
              activated: false,
              reason: "context_pack_hydration_failed",
              source_client: SOURCE_CLIENT,
              session_id: activeSessionId,
              prior_activation_cleared: clearance?.cleared === true,
              clear_reason: clearance?.reason || "clear_not_attempted",
            },
          }
        : {}),
    };
  }
}

function boundedUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[OrgX context truncated at the Cursor hook boundary.]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  const bytes = Buffer.from(value, "utf8").subarray(0, budget);
  let bounded = bytes.toString("utf8");
  while (Buffer.byteLength(bounded, "utf8") > budget) bounded = bounded.slice(0, -1);
  return bounded + suffix;
}

/** Build Cursor's sessionStart stdout contract without exposing hook internals. */
export function buildCursorSessionStartOutput(result) {
  if (!isRecord(result)) return {};
  const sessionContext = isRecord(result.session_context)
    ? result.session_context
    : undefined;
  if (!sessionContext && !result.skipped) return {};

  const activated = sessionContext?.activated === true;
  const hasBoundedContext =
    isRecord(result.session_work_context) &&
    jsonBytes(result.session_work_context) <= MAX_SESSION_WORK_CONTEXT_BYTES;
  const payload = {
    schema_version: "orgx-cursor-session-start-context/v1",
    status: activated ? "ready" : hasBoundedContext ? "pending" : "missing",
    authority: activated ? "wizard_validated" : "not_active",
    source_client: SOURCE_CLIENT,
    ...(sessionContext?.session_id
      ? { session_id: sessionContext.session_id }
      : {}),
    ...(sessionContext?.context_sha256
      ? { context_sha256: sessionContext.context_sha256 }
      : {}),
    reason: sessionContext?.reason || result.skipped,
    ...(hasBoundedContext ? { context: result.session_work_context } : {}),
  };
  const preface = activated
    ? "OrgX activated this producer-asserted briefing for this exact Cursor session. Refresh consequential state before acting."
    : "OrgX did not activate authority for this Cursor session. Any included producer-asserted briefing is informational only.";
  return {
    additional_context: boundedUtf8(
      `${preface}\n${canonicalJson(payload)}`,
      MAX_ADDITIONAL_CONTEXT_BYTES
    ),
  };
}

if (isDirectRun()) {
  readStdin()
    .then((stdinText) => main({ stdinText }))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(buildCursorSessionStartOutput(result))}\n`);
    })
    .catch(async (error) => {
      await captureCursorHookException(error, { hook: "hydrate-context-pack" });
      process.stdout.write(
        `${JSON.stringify({
          additional_context:
            "OrgX session context hydration failed. No OrgX authority is active for this Cursor session.",
        })}\n`
      );
    });
}
