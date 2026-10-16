-- 0018_od_opened_tracking.sql
-- ---------------------------------------------------------------------------
-- Lets the OD inbox tell a request nobody on the OD team has opened yet from
-- one that is merely waiting for a decision — the same distinction the HRBP
-- inbox already has for free ('submitted' = not opened, 'hrbp_review' =
-- opened; hrbp_mark_in_review(), 0004). OD has no status for it, so it gets a
-- timestamp instead:
--
--   * requests.od_opened_at   NULL  = in OD review and not opened yet
--                             a time = an OD team member has opened it
--   * od_mark_opened(id)      called when OD opens the review page; sets
--                             od_opened_at once and is otherwise a no-op
--                             (wrong status, not an OD member, already opened)
--   * enforce_request_transition() clears od_opened_at every time a request
--     ENTERS od_review, so a request HRBP forwards back to OD after an OD
--     return counts as new to OD again.
--
-- Existing requests that are in od_review right now start as not opened (the
-- database has no record of whether anyone looked at them); each one stops
-- being "new" the first time an OD member opens it.
--
-- The 0015 column guard needs no change: od_opened_at can only be written
-- through requests_od_update (OD team, status od_review), and any value set
-- earlier is wiped when the request enters od_review.
--
-- enforce_request_transition() is 0007's, unchanged except for the one line
-- that clears od_opened_at.
--
-- Run once in the Supabase Dashboard -> SQL Editor (after 0017). Safe to re-run.
-- ---------------------------------------------------------------------------

alter table requests add column if not exists od_opened_at timestamptz;

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
    new.od_opened_at = null;
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

create or replace function od_mark_opened(p_request_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  update requests
  set od_opened_at = now()
  where id = p_request_id
    and status = 'od_review'
    and od_opened_at is null
    and is_od_team(auth.uid());
  -- No matching row is not an error: this is a best-effort "mark as opened",
  -- like hrbp_mark_in_review(), not something the user did.
end;
$$;

notify pgrst, 'reload schema';
