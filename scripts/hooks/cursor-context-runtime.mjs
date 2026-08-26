import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

export const PACK_FILENAME = "orgx-context-pack.json";
export const PENDING_CONTEXT_FILENAME =
  "orgx-session-work-context.activation-pending.json";
export const SOURCE_CLIENT = "cursor";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isPathWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

/** Sort object keys recursively; preserve array order; omit undefined values. */
export function canonicalizeJson(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => canonicalizeJson(item));
  }
  if (!isRecord(value)) return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    sorted[key] = canonicalizeJson(value[key]);
  }
  return sorted;
}

export function canonicalJson(value) {
  const serialized = JSON.stringify(canonicalizeJson(value));
  if (typeof serialized !== "string") {
    throw new TypeError("value is not JSON serializable");
  }
  return serialized;
}

export function contextSha256(context) {
  return createHash("sha256").update(canonicalJson(context), "utf8").digest("hex");
}

function defaultRuntimeRoot(env) {
  const explicit = typeof env.ORGX_CURSOR_CONTEXT_HOME === "string"
    ? env.ORGX_CURSOR_CONTEXT_HOME.trim()
    : "";
  if (explicit) return isAbsolute(explicit) ? resolve(explicit) : undefined;

  for (const [value, suffix] of [
    [env.XDG_STATE_HOME, ["useorgx", "cursor", "sessions"]],
    [env.XDG_CONFIG_HOME, ["useorgx", "cursor", "sessions"]],
    [env.LOCALAPPDATA, ["useorgx", "cursor", "sessions"]],
    [env.APPDATA, ["useorgx", "cursor", "sessions"]],
  ]) {
    if (typeof value === "string" && value.trim() && isAbsolute(value.trim())) {
      return resolve(value.trim(), ...suffix);
    }
  }
  return resolve(homedir(), ".config", "useorgx", "cursor", "sessions");
}

export function resolveSessionRuntimePaths({ projectDir, sessionId, env = {} } = {}) {
  if (!projectDir || !sessionId) return undefined;
  const root = defaultRuntimeRoot(env);
  if (!root) return undefined;
  const key = createHash("sha256")
    .update(`${projectDir}\0${SOURCE_CLIENT}\0${sessionId}`, "utf8")
    .digest("hex");
  const directory = join(root, key);
  return {
    root,
    directory,
    packPath: join(directory, PACK_FILENAME),
    pendingPath: join(directory, PENDING_CONTEXT_FILENAME),
  };
}

function ensurePrivateRuntimeDirectory(paths, projectDir) {
  if (!paths) throw new Error("runtime_path_unavailable");
  if (isPathWithin(projectDir, paths.root)) {
    throw new Error("runtime_root_inside_project");
  }

  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  if (lstatSync(paths.root).isSymbolicLink()) {
    throw new Error("runtime_root_symlink");
  }
  chmodSync(paths.root, 0o700);
  const canonicalRoot = realpathSync(paths.root);
  if (isPathWithin(projectDir, canonicalRoot)) {
    throw new Error("runtime_root_inside_project");
  }

  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const sessionStat = lstatSync(paths.directory);
  if (sessionStat.isSymbolicLink()) throw new Error("runtime_session_symlink");
  if (!sessionStat.isDirectory()) throw new Error("runtime_session_not_directory");
  chmodSync(paths.directory, 0o700);
  const canonicalDirectory = realpathSync(paths.directory);
  if (!isPathWithin(canonicalRoot, canonicalDirectory)) {
    throw new Error("runtime_session_escape");
  }
  return canonicalDirectory;
}

export function privateRuntimeJsonWrite(paths, projectDir, path, value) {
  const directory = ensurePrivateRuntimeDirectory(paths, projectDir);
  if (
    dirname(path) !== paths.directory ||
    realpathSync(dirname(path)) !== directory
  ) {
    throw new Error("runtime_target_escape");
  }
  const temporaryPath = join(
    directory,
    `.orgx-context.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX modes.
  }
  return path;
}

function safeRuntimeDirectory(paths) {
  try {
    if (!paths || !existsSync(paths.root) || lstatSync(paths.root).isSymbolicLink()) {
      return undefined;
    }
    const canonicalRoot = realpathSync(paths.root);
    if (!existsSync(paths.directory) || lstatSync(paths.directory).isSymbolicLink()) {
      return undefined;
    }
    const canonicalDirectory = realpathSync(paths.directory);
    return isPathWithin(canonicalRoot, canonicalDirectory)
      ? canonicalDirectory
      : undefined;
  } catch {
    return undefined;
  }
}

export function removeSessionRuntimeState({ projectDir, sessionId, env = {} } = {}) {
  try {
    const paths = resolveSessionRuntimePaths({ projectDir, sessionId, env });
    if (!paths) return false;
    if (!existsSync(paths.root)) return true;
    if (lstatSync(paths.root).isSymbolicLink()) return false;
    if (!existsSync(paths.directory)) return true;
    const directory = safeRuntimeDirectory(paths);
    if (!directory) return false;
    for (const filename of [PACK_FILENAME, PENDING_CONTEXT_FILENAME]) {
      try {
        unlinkSync(join(directory, filename));
      } catch {
        // Missing or locked state is checked after the deletion attempt.
      }
    }
    try {
      rmdirSync(directory);
    } catch {
      // Preserve a non-empty private directory rather than deleting unknown files.
    }
    return !existsSync(directory);
  } catch {
    return false;
  }
}

export function removePendingContext(paths) {
  const directory = safeRuntimeDirectory(paths);
  if (!directory) return;
  try {
    unlinkSync(join(directory, PENDING_CONTEXT_FILENAME));
  } catch {
    // Missing or locked stale state is non-fatal.
  }
}

export function persistPendingSessionWorkContext(paths, projectDir, context) {
  return privateRuntimeJsonWrite(paths, projectDir, paths.pendingPath, context);
}
