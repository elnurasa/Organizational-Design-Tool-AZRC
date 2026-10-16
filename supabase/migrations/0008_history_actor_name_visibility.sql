-- 0008_history_actor_name_visibility.sql
-- ---------------------------------------------------------------------------
-- Fixes the Approval Trail showing blank actor names: request_history rows
-- are correctly visible via history_follow_request (0003), but resolving an
-- actor_id to a full_name is a separate SELECT against `users`, gated by the
-- much narrower users_read policy (self / any Admin / any active HRBP only).
-- A Manager's or OD team member's name was never covered by that policy, so
-- e.g. an HRBP viewing "Irina — created this request as a draft" in the
-- trail got a name lookup that resolved to nothing ("—").
--
-- Fix: extend users_read so a user's name is also visible to anyone who can
-- already see a request that user acted on (requester, assigned HRBP once
-- non-draft, or anyone covered by the existing requests_od_read policy) —
-- i.e. "if you can read the request, you can read the names of everyone in
-- its Approval Trail," nothing wider. Mirrors the exact same predicates as
-- requests_manager_read / requests_hrbp_read / requests_od_read (0003) for
-- consistency with the already-established visibility model.
-- ---------------------------------------------------------------------------

drop policy if exists users_read on users;

create policy users_read on users for select using (
  auth.uid() = id
  or is_admin(auth.uid())
  or (role = 'hrbp' and is_active)
  or exists (
    select 1
    from request_history rh
    join requests r on r.id = rh.request_id
    where rh.actor_id = users.id
      and (
        r.requester_id = auth.uid()
        or (r.assigned_hrbp_id = auth.uid() and r.status <> 'draft')
        or r.status in ('od_review', 'approved', 'rejected')
        or r.od_reviewed
      )
  )
);

notify pgrst, 'reload schema';
