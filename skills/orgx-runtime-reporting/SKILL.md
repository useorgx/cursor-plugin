---
name: orgx-runtime-reporting
description: Use when Cursor should report artifacts, blockers, or verified completion back to OrgX during a live task.
---

# OrgX Runtime Reporting

The bundled connection selects `profile=v2`. Reconnect after plugin or server
updates and use only its authenticated callable tools.

1. Resolve the current workspace, initiative, task, and run from supplied
   context or `orgx_get_workspace_context`; never infer their state from memory.
2. For reporting, use `orgx_get_operator_brief` with `period: "30d"`, `"day"`,
   or `"week"`. Lead with `reportingNarrative.briefMarkdown`, then cite gaps
   and next actions. Use `orgx_get_next_actions` for priorities, without a mode.
3. Register concrete proof with `orgx_attach_artifact`, supplying the work
   target and durable `location.artifact_url` or `location.external_url`.
4. Capture judgment requests with `orgx_capture_decision`; read pending items
   with `orgx_list_pending_decisions` and use `orgx_open_decision_review` to
   share `data.review_url`. Only a person settles the decision.
5. Track started work with `orgx_get_operation_status`, using a typed
   `operation_id` or `kind` and `id`. Honor `next_poll_after_ms`; launching
   or delegating work does not complete it.
6. Validate the complete portable document with `orgx_validate_work_receipt`
   and import with `orgx_submit_work_receipt`. Keep producer verification
   separate from human acceptance; never rename a condensed runtime payload.
7. Use `orgx_complete_work_with_proof` only after verification and report its
   real outcome, including proof recorded with completion blocked or pending.

The named workflow profile has no generic activity reporting router. Progress
events use the existing authorized Work Graph HTTP path or local evidence.
Passive Cursor hooks retain their existing compact HTTP delivery path.
When IDs or transport are missing, continue the local task and report that
OrgX delivery is pending; never claim a write succeeded without its result.

Reconcile uncertain writes before retrying; replay only when the documented
operation supports it, with identical input and the original idempotency key.
Never call app-only human actions or retry a write through another name.
Preserve safe Work Graph fingerprints and hydration keys, and keep tokens,
cookies, API keys, and raw transcripts out of summaries. Supply attribution
only when the operation's advertised input supports it.
