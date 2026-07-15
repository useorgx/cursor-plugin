#!/usr/bin/env node

import { exitCodeForResult, main, readStdin } from './record-work-graph-event.mjs';
import { captureCursorHookException } from './sentry.mjs';

readStdin()
  .then((stdinText) =>
    main({ argv: ['--event=subagent_stop', '--source_client=cursor'], stdinText })
  )
  .then((result) => process.exit(exitCodeForResult(result)))
  .catch(async (error) => {
    await captureCursorHookException(error, { hook: 'subagent-stop' });
    process.stderr.write(`OrgX Cursor subagent-stop hook failed: ${error.message}\n`);
    process.exit(1);
  });
