# OrgX Execution Control Plane

Use this skill when the task uses an active OrgX initiative or workstream inside Cursor.

## Goal

Keep Cursor work anchored to OrgX workstreams, decisions, proof, and execution state instead of ad-hoc chat history.

This package selects `v2`. Reconnect after updates and use only the named
operations in the authenticated callable inventory.

## Workflow

1. Use supplied current workspace context or read it with `orgx_get_workspace_context` when OrgX state is needed.
2. Prefer resume over create when relevant work already exists.
3. Associate relevant work with the supplied workstream or task when IDs are available; ordinary repo work does not require creating tracking entities first.
4. Surface blockers and pending decisions explicitly.
5. Close with proof, artifacts, and concrete next actions.

## Guardrails

- Do not invent work that is not grounded in the active OrgX context.
- Do not call work complete without verification.
- Do not call a decision approved or a spawned run done until OrgX says so: decisions are settled only by a person (`review_url`), and `orgx_get_operation_status` reports a run's real state.
- Keep repo-local `.cursor/orgx/` overlays additive to the plugin defaults.
- Missing OrgX context, transport, or reporting is a continuity limitation, not a prerequisite to editing, checking, updating a PR, or performing a user-authorized merge. Continue local work and report any pending OrgX write separately. OrgX decision review rules apply to those decisions; they do not require a new decision for every repo action.
