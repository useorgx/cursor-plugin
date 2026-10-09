Review OrgX decisions that still need a person's call.

Checklist:
- List the pending decisions in priority order.
- Give enough context for the person to approve or reject safely.
- You cannot settle a decision. Calling `orgx_open_decision_review` returns where the person decides: the decisions widget's Approve button for ordinary decisions, otherwise the decision page in OrgX (`review_url`). Point the person there; never call `orgx_widget_decide`.
- Never say a decision was approved or rejected unless OrgX shows it settled (`orgx_get_operation_status` with `kind: "decision"`).
- If a decision blocks execution, say exactly what remains blocked and that it is waiting on the person.
