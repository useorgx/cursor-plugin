const DEFAULT_DSN =
  'https://8c918638b4bd7bba5c0b54b52018feba@o4507108730077184.ingest.us.sentry.io/4511736557666304';
const PACKAGE_NAME = '@useorgx/cursor-plugin';
const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|session|prompt|input|output|completion|model[_-]?(?:input|output))(?:$|[_-])/i;

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(value ?? '').trim().toLowerCase()
  );
}

function sampleRate(value, fallback = 0.02) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
}

function redactText(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\boxk_[A-Za-z0-9_-]+\b/g, 'oxk_[redacted]')
    .replace(/\bsntrys_[A-Za-z0-9_-]+\b/g, 'sntrys_[redacted]')
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .replace(/\/home\/[^/\s]+/g, '/home/[user]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[user]');
}

export function sanitizeCursorTelemetry(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCursorTelemetry(entry, depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: redactText(value.name),
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitizeCursorTelemetry(entry, depth + 1);
  }
  return sanitized;
}

function telemetryDisabled(env) {
  return (
    isTruthy(env.ORGX_TELEMETRY_DISABLED) ||
    isTruthy(env.ORGX_SENTRY_DISABLED) ||
    isTruthy(env.CURSOR_TELEMETRY_DISABLED)
  );
}

/**
 * Load Sentry only on an error path so the high-frequency Cursor hooks retain
 * their existing startup latency. Error payloads are scrubbed before capture,
 * and the short flush keeps CLI failures observable without hanging Cursor.
 */
export async function captureCursorHookException(
  error,
  tags = {},
  { env = process.env, version = '0.1.2' } = {}
) {
  const dsn = env.ORGX_SENTRY_DSN?.trim() || DEFAULT_DSN;
  if (!dsn || telemetryDisabled(env)) return false;

  try {
    const Sentry = await import('@sentry/node');
    if (!Sentry.isInitialized()) {
      Sentry.init({
        dsn,
        environment: env.ORGX_SENTRY_ENVIRONMENT || 'production',
        release: `${PACKAGE_NAME}@${version}`,
        tracesSampleRate: sampleRate(env.ORGX_SENTRY_TRACES_SAMPLE_RATE),
        enableLogs: true,
        sendDefaultPii: false,
        includeServerName: false,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: { request: false, response: false },
          httpBodies: [],
          queryParams: false,
          genAI: { inputs: false, outputs: false },
          stackFrameVariables: false,
          frameContextLines: 3,
        },
        initialScope: {
          tags: { service: 'orgx-clients', surface: 'cursor-plugin' },
        },
        beforeBreadcrumb: (breadcrumb) =>
          breadcrumb.category === 'console'
            ? null
            : sanitizeCursorTelemetry(breadcrumb),
        beforeSend(event) {
          const sanitized = sanitizeCursorTelemetry(event);
          delete sanitized.user;
          delete sanitized.request;
          return sanitized;
        },
        beforeSendTransaction: (event) => sanitizeCursorTelemetry(event),
        beforeSendLog: (log) => sanitizeCursorTelemetry(log),
      });
    }

    const sanitizedError = sanitizeCursorTelemetry(
      error instanceof Error ? error : new Error(String(error))
    );
    const reportableError = new Error(sanitizedError.message);
    reportableError.name = sanitizedError.name;
    reportableError.stack = sanitizedError.stack;

    Sentry.captureException(reportableError, {
      tags: sanitizeCursorTelemetry(tags),
    });
    await Sentry.flush(2_000);
    return true;
  } catch {
    return false;
  }
}
