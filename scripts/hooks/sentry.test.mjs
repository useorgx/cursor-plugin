import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeCursorTelemetry } from './sentry.mjs';

test('sanitizeCursorTelemetry removes secrets and local usernames', () => {
  const sanitized = sanitizeCursorTelemetry({
    authorization: 'Bearer secret-token',
    nested: {
      api_key: 'oxk_should_not_leave',
      message: 'failed at /Users/hope/private with token=abc123',
    },
  });

  assert.deepEqual(sanitized, {
    authorization: '[redacted]',
    nested: {
      api_key: '[redacted]',
      message: 'failed at /Users/[user]/private with token=[redacted]',
    },
  });
});

test('sanitizeCursorTelemetry truncates deeply nested values', () => {
  const sanitized = sanitizeCursorTelemetry({
    a: {
      b: {
        c: {
          d: {
            e: {
              f: { g: 'hidden' },
            },
          },
        },
      },
    },
  });

  assert.equal(sanitized.a.b.c.d.e.f, '[truncated]');
});
