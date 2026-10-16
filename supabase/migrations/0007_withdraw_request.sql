-- =============================================================================
-- 0007_withdraw_request.sql
-- -----------------------------------------------------------------------------
-- New capability: once HRBP has returned a request to the requester
-- (status = 'returned_to_requester' — reached either from HRBP's first
-- review, or after OD sent it back to HRBP and HRBP returned it again), the
-- requesting Manager may withdraw it instead of fixing and resubmitting.
--
-- Implementation, matching the existing architecture exactly rather than
-- bolting on a special case:
--   1. 'withdrawn' becomes a legal value in requests.status (was previously
--      only reachable via 'approved'/'rejected' as the other two terminal
--      states).
--   2. enforce_request_transition() gets exactly one new allowed edge:
--      returned_to_requester -> withdrawn, by the manager who owns the
--      request. Every other transition rule is untouched.
--   3. A new SECURITY INVOKER RPC, withdraw_request(), matching the shape of
--      submit_structural_request() — one transactional call that updates the
--      row and appends the request_history entry together, rather than two
--      separate client-side writes. It runs as the calling manager, so it's
--      still fully subject to requests_manager_update's RLS (already permits
--      UPDATE while status is 'returned_to_requester' — see 0003's comment
--      on why that policy's WITH CHECK doesn't re-restrict the resulting
--      status) and to the trigger above.
--
-- No RLS policy changes needed: requests_manager_update already covers this
-- (status in ('draft', 'returned_to_requester') pre-update), and its WITH
-- CHECK only re-confirms ownership, not the resulting status.
--
-- Visibility once withdrawn: HRBP already sees every non-draft status on
-- requests assigned to them (requests_hrbp_read has no status filter beyond
-- status <> 'draft'), so a withdrawn request stays visible there
-- automatically. OD sees it if and only if they already had visibility
-- (status history reached od_review at some point, i.e. od_reviewed = true)
-- — a request HRBP returned on first review, that OD never saw, correctly
-- stays invisible to OD after being withdrawn too; nothing changes about who
-- already had access to what, only that the request's own status can now
-- become 'withdrawn'. Both HRBP's and OD's review pages already render any
-- status outside their own actionable set as read-only, so no page-specific
-- "withdrawn" case is needed there either.
-- =============================================================================

alter table requests drop constraint requests_status_check;
alter table requests add constraint requests_status_check check (status in (
  'draft', 'submitted', 'hrbp_review', 'returned_to_requester', 'od_review',
  'returned_to_hrbp', 'approved', 'rejected', 'withdrawn'
));

create or replace function enforce_request_transition()
returns trigger
language plpgsql
as $$
declare
  caller_role text;
begin
  if new.status = old.status then
    return new;
  end if;

  select role into caller_role from users where id = auth.uid();

  if not (
    (old.status = 'draft' and new.status = 'submitted' and caller_role = 'manager') or
    (old.status = 'submitted' and new.status = 'hrbp_review' and caller_role = 'hrbp') or
    (old.status = 'submitted' and new.status = 'returned_to_requester' and caller_role = 'hrbp') or
    (old.status = 'hrbp_review' and new.status = 'od_review' and caller_role = 'hrbp') or
    (old.status = 'hrbp_review' and new.status = 'returned_to_requester' and caller_role = 'hrbp') or
    (old.status = 'od_review' and new.status = 'approved' and caller_role = 'od_team') or
    (old.status = 'od_review' and new.status = 'returned_to_hrbp' and caller_role = 'od_team') or
    (old.status = 'od_review' and new.status = 'rejected' and caller_role = 'od_team') or
    (old.status = 'returned_to_hrbp' and new.status = 'od_review' and caller_role = 'hrbp') or
    (old.status = 'returned_to_hrbp' and new.status = 'returned_to_requester' and caller_role = 'hrbp') or
    (old.status = 'returned_to_requester' and new.status = 'submitted' and caller_role = 'manager') or
    (old.status = 'returned_to_requester' and new.status = 'withdrawn' and caller_role = 'manager')
  ) then
    raise exception 'Invalid request status transition: % -> % by role %', old.status, new.status, caller_role;
  end if;

  if new.status = 'od_review' and old.status <> 'od_review' then
    new.od_reviewed = true;
  end if;
  if new.status = 'submitted' then
    new.submitted_at = now();
  end if;
  if new.status in ('approved', 'rejected', 'withdrawn') then
    new.resolved_at = now();
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- withdraw_request: the requester's own "I no longer want this" action,
-- available only while the request is sitting back with them
-- (returned_to_requester). Terminal, like approve/reject — a withdrawn
-- request cannot be resubmitted or re-edited.
-- ---------------------------------------------------------------------------
create function withdraw_request(
  p_request_id uuid,
  p_comment text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_status text;
begin
  select status into v_old_status from requests
    where id = p_request_id and requester_id = auth.uid();

  if v_old_status is null then
    raise exception 'This request could not be found.';
  end if;
  if v_old_status <> 'returned_to_requester' then
    raise exception 'Only a request that has been returned to you can be withdrawn.';
  end if;

  update requests set status = 'withdrawn' where id = p_request_id;

  insert into request_history (request_id, actor_id, action, from_status, to_status, comment)
    values (p_request_id, auth.uid(), 'withdrawn', v_old_status, 'withdrawn', p_comment);
end;
$$;
