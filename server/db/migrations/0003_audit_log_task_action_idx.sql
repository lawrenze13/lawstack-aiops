-- Composite index on audit_log(task_id, action) — backs every per-task
-- audit lookup added by the multi-cycle support feature (cycle helpers
-- in server/lib/taskCycle.ts read by the card-detail page on every
-- render). Without this, those queries fall back to the action-only
-- index and filter by task_id post-fetch — unbounded scan as audit
-- history grows. See:
--   docs/plans/2026-05-01-fix-card-detail-bug-cluster-plan.md
--   (Deepen-Plan Research Findings → performance-oracle finding #1)
CREATE INDEX `audit_log_task_action_idx` ON `audit_log` (`task_id`,`action`);
