-- 0016_users_read_signed_in_only_and_history_guard.sql
-- ---------------------------------------------------------------------------
-- Two small tightenings found while hardening the request workflow (0014,
-- 0015). Passwords and sign-in are deliberately NOT touched here.
--
-- 1. users_read let a request with NO sign-in at all list every active HRBP.
--    The policy's `role = 'hrbp' and is_active` clause (0003, kept by 0008)
--    never looked at who was asking, and the anon key ships in js/config.js,
--    so anyone on the internet could read the name, e-mail and job title of
--    every active HRBP straight from the REST API. The request form's HRBP
--    dropdown only ever runs after sign-in, so the clause now requires a
--    signed-in user. Everything else in the policy is exactly 0008's.
--
-- 2. request_history_insert (0003) only checked actor_id = auth.uid(). Any
--    signed-in user could therefore append a row to ANY request's Approval
--    Trail through the REST API — e.g. "<their name> approved this request" —
--    because the workflow RPCs run as the caller and need that same policy.
--    The trail is the audit record of who did what, so it must only ever be
--    written by the workflow actions themselves. Every one of them (create a
--    draft, submit, HRBP review, OD review, withdraw) changes the request row
--    and writes its history entry in the same transaction, so the guard below
--    requires exactly that: the request's updated_at must equal this
--    transaction's timestamp. A bare INSERT sent straight to the API is its
--    own transaction and can never satisfy it.
--
-- Callers with no end-user identity (auth.uid() is null: the SQL editor, a
-- migration, the service_role key) are not restricted.
--
-- Run once in the Supabase Dashboard -> SQL Editor, after 0015 (which makes
-- 0008's users_read safe to keep: it removes the requests <-> users policy
-- cycle). Safe to re-run.
-- ---------------------------------------------------------------------------

drop policy if exists users_read on users;

create policy users_read on users for select using (
  auth.uid() = id
  or is_admin(auth.uid())
  or (auth.uid() is not null and role = 'hrbp' and is_active)
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

create or replace function guard_history_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if not exists (
    select 1 from requests r
    where r.id = new.request_id and r.updated_at = now()
  ) then
    raise exception 'Approval Trail entries can only be written by the workflow actions themselves.';
  end if;

  return new;
end;
$$;

drop trigger if exists request_history_guard_insert on request_history;
create trigger request_history_guard_insert
  before insert on request_history
  for each row execute function guard_history_insert();

notify pgrst, 'reload schema';
