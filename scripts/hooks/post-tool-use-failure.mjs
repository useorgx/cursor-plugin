#!/usr/bin/env node

import { exitCodeForResult, main, readStdin } from './record-work-graph-event.mjs';
import { captureCursorHookException } from './sentry.mjs';

readStdin()
  .then((stdinText) =>
    main({
      argv: ['--event=post_tool_use_failure', '--source_client=cursor'],
      stdinText,
    })
  )
  .then((result) => process.exit(exitCodeForResult(result)))
  .catch(async (error) => {
    await captureCursorHookException(error, { hook: 'post-tool-use-failure' });
    process.stderr.write(`OrgX Cursor post-tool-use-failure hook failed: ${error.message}\n`);
    process.exit(1);
  });
