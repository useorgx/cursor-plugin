#!/usr/bin/env node

import { exitCodeForResult, main, readStdin } from './record-work-graph-event.mjs';

// Cursor Agent CLI 2026.06 can finish a headless run without emitting `stop`
// or `sessionEnd`. `afterAgentResponse` is the documented local/CLI lifecycle
// event that still fires after the final response. Treat it as the same bounded
// RunEnd fallback; if `stop` also fires, the shared hook has already cleared the
// state and the second event is an idempotent no-op.
readStdin()
  .then((stdinText) =>
    main({ argv: ['--event=run_end', '--source_client=cursor'], stdinText })
  )
  .then((result) => process.exit(exitCodeForResult(result)))
  .catch(() => process.exit(1));
