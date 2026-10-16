-- 0009_fix_od_read_role_scope.sql
-- ---------------------------------------------------------------------------
-- CRITICAL FIX: requests_od_read (0003) had no role/actor check at all —
-- `status in ('od_review','approved','rejected') or od_reviewed` depends
-- only on the ROW, never on who's asking. Postgres combines multiple
-- permissive RLS SELECT policies with OR, so once a request reached OD
-- review this policy alone made it readable by EVERY authenticated user —
-- any other Manager, not just the OD team — regardless of what
-- requests_manager_read/requests_hrbp_read already correctly restricted.
--
-- js/request-service.js's listMyRequests() (a Manager's "My Requests" list)
-- deliberately does a plain `select * from requests` with no client-side
-- requester_id filter, relying on RLS alone to scope it to "my own
-- requests" (see that function's own comment) — so this policy bug directly
-- leaked every OTHER Manager's request into a Manager's own list once that
-- request reached od_review/approved/rejected. request_answers and
-- request_history both follow the parent request's own RLS visibility (see
-- answers_follow_request / history_follow_request, also 0003), so they were
-- leaking the same way — fixing this one policy closes all three at once.
--
-- Fix: scope this policy to actual OD team members only, matching how
-- requests_hrbp_read/requests_manager_read already correctly scope their
-- own roles. OD has no per-request assignment column (no assigned_od_id —
-- see the comment on requests_od_update below), so every od_team member
-- still sees every such request, unchanged for that role — only the
-- accidental grant to non-OD roles (Manager, HRBP) is removed. Admin
-- visibility is unaffected either way (requests_admin_read is a separate
-- policy, unconditional on is_admin()).
-- ---------------------------------------------------------------------------

drop policy if exists requests_od_read on requests;

create policy requests_od_read on requests for select using (
  (status in ('od_review', 'approved', 'rejected') or od_reviewed)
  and exists (select 1 from users u where u.id = auth.uid() and u.role = 'od_team')
);

notify pgrst, 'reload schema';
