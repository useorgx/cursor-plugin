#!/usr/bin/env node

import { exitCodeForResult, main, readStdin } from './record-work-graph-event.mjs';

readStdin()
  .then((stdinText) =>
    main({ argv: ['--event=session_end', '--source_client=cursor'], stdinText })
  )
  .then((result) => process.exit(exitCodeForResult(result)))
  .catch(() => process.exit(1));
