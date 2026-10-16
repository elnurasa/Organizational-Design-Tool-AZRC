-- =============================================================================
-- 0003_unify_users_and_requests.sql
-- -----------------------------------------------------------------------------
-- Step 1 of the Structural Change Request workflow.
--
-- Supersedes the role-table portion of 0001_admin_panel.sql /
-- 0002_remove_account_column.sql: "managers" / "hrbps" / "od" collapse into a
-- single "users" table (role text: 'manager' | 'hrbp' | 'od_team'). Written
-- defensively — migrates existing rows out of the old tables if they exist,
-- otherwise just creates "users" fresh — since it's unconfirmed whether
-- 0001/0002 were ever run against a real project.
--
-- admin_permissions is untouched: Admin stays an orthogonal permission (not
-- a 4th role value), and its FK already targets auth.users(id), which this
-- migration doesn't change the meaning of (users.id IS auth.users(id)).
--
-- All writes to "users" still go exclusively through the Apps Script Web App
-- (apps-script/Code.gs) using the service_role key, same as before — no
-- insert/update/delete RLS policy is defined for anon/authenticated below,
-- by design.
--
-- Run this once in the Supabase Dashboard -> SQL Editor, after 0001 (for
-- pg_trgm, is_admin(), set_updated_at(), admin_permissions) if that was run,
-- or standalone against a fresh project (see notes on each object below for
-- what it assumes already exists).
-- =============================================================================

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.managers') is not null then
    create table users (
      id uuid primary key references auth.users(id) on delete cascade,
      email text not null unique,
      full_name text,
      role text not null check (role in ('manager', 'hrbp', 'od_team')),
      company text,
      job_title text,
      division text,
      department text,
      subdepartment text,
      unit text,
      subunit text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (role <> 'manager' or (division is not null and department is not null))
    );

    insert into users (id, email, full_name, role, job_title, division, department, subdepartment, unit, subunit)
      select auth_user_id, mail, full_name, 'manager', job_title, division, department, subdepartment, unit, subunit
      from managers
      where auth_user_id is not null;

    insert into users (id, email, full_name, role, job_title)
      select auth_user_id, mail, full_name, 'hrbp', job_title
      from hrbps
      where auth_user_id is not null;

    insert into users (id, email, full_name, role, job_title)
      select auth_user_id, mail, full_name, 'od_team', job_title
      from od
      where auth_user_id is not null;

    drop view if exists admin_all_employees;
    drop table managers, hrbps, od;
  else
    create table users (
      id uuid primary key references auth.users(id) on delete cascade,
      email text not null unique,
      full_name text,
      role text not null check (role in ('manager', 'hrbp', 'od_team')),
      company text,
      job_title text,
      division text,
      department text,
      subdepartment text,
      unit text,
      subunit text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (role <> 'manager' or (division is not null and department is not null))
    );
  end if;
end $$;

create index users_role_idx on users (role);
create index users_full_name_trgm_idx on users using gin (full_name gin_trgm_ops);

-- set_updated_at() is defined in 0001_admin_panel.sql. If running this
-- migration standalone against a fresh project, create it first:
--   create function set_updated_at() returns trigger language plpgsql as $$
--     begin new.updated_at = now(); return new; end; $$;
create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- requests
-- ---------------------------------------------------------------------------
create table requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references users(id),
  status text not null default 'draft' check (status in (
    'draft', 'submitted', 'hrbp_review', 'returned_to_requester', 'od_review',
    'returned_to_hrbp', 'approved', 'rejected'
  )),
  category text not null,
  change_description text,
  justification text,
  requested_effective_date date,
  assigned_hrbp_id uuid references users(id),

  -- Set true the first time status enters 'od_review' and never reset, so
  -- OD keeps visibility into anything they've ever touched even after a
  -- returned_to_hrbp round trip or a final approved/rejected outcome — the
  -- literal "OD sees requests in od_review status" RLS rule would otherwise
  -- make OD lose access the moment they act on a request.
  od_reviewed boolean not null default false,

  -- Requester profile, snapshotted at submit time rather than joined live —
  -- keeps the approved-PDF record accurate even if the profile changes
  -- later, and avoids needing HRBP/OD to have read access to an arbitrary
  -- manager's users row.
  requester_full_name text,
  requester_company text,
  requester_job_title text,
  requester_division text,
  requester_department text,
  requester_subdepartment text,
  requester_unit text,
  requester_subunit text,
  requester_email text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  resolved_at timestamptz
);

create index requests_requester_idx on requests (requester_id);
create index requests_hrbp_idx on requests (assigned_hrbp_id);
create index requests_status_idx on requests (status);

create trigger requests_set_updated_at
  before update on requests
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- request_answers
-- ---------------------------------------------------------------------------
create table request_answers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  question_key text not null,
  question_text text not null,
  answer text,
  hrbp_verdict text check (hrbp_verdict is null or hrbp_verdict in ('sufficient', 'insufficient')),
  hrbp_comment text,
  od_verdict text check (od_verdict is null or od_verdict in ('sufficient', 'insufficient')),
  od_comment text,
  sort_order int not null default 0,
  unique (request_id, question_key)
);

create index request_answers_request_idx on request_answers (request_id);

-- ---------------------------------------------------------------------------
-- request_history
-- ---------------------------------------------------------------------------
create table request_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  actor_id uuid references users(id),
  action text not null,
  from_status text,
  to_status text,
  comment text,
  created_at timestamptz not null default now()
);

create index request_history_request_idx on request_history (request_id);

-- ---------------------------------------------------------------------------
-- State machine enforcement. RLS below controls which ROWS a role may
-- UPDATE; it can't by itself restrict which NEW status value is valid for
-- the OLD one. This trigger is what actually makes "no other transitions
-- are valid" true server-side — every one of the 10 listed transitions,
-- each tied to the role allowed to make it.
-- ---------------------------------------------------------------------------
create function enforce_request_transition()
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
    (old.status = 'returned_to_hrbp' and new.status = 'od_review' and caller_role = 'hrbp') or
    (old.status = 'returned_to_hrbp' and new.status = 'returned_to_requester' and caller_role = 'hrbp') or
    (old.status = 'returned_to_requester' and new.status = 'submitted' and caller_role = 'manager')
  ) then
    raise exception 'Invalid request status transition: % -> % by role %', old.status, new.status, caller_role;
  end if;

  if new.status = 'od_review' and old.status <> 'od_review' then
    new.od_reviewed = true;
  end if;
  if new.status = 'submitted' then
    new.submitted_at = now();
  end if;
  if new.status in ('approved', 'rejected') then
    new.resolved_at = now();
  end if;

  return new;
end;
$$;

create trigger requests_enforce_transition
  before update on requests
  for each row execute function enforce_request_transition();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table users enable row level security;
alter table requests enable row level security;
alter table request_answers enable row level security;
alter table request_history enable row level security;

-- is_admin() is defined in 0001_admin_panel.sql. If running this migration
-- standalone against a fresh project, create it first — see that file.

-- Own profile, any Admin, or (needed for the HRBP-assignment dropdown on
-- the request form) any active HRBP's row is visible to any signed-in user.
create policy users_read on users for select using (
  auth.uid() = id or is_admin(auth.uid()) or (role = 'hrbp' and is_active)
);

create policy requests_manager_read on requests for select using (requester_id = auth.uid());
create policy requests_manager_insert on requests for insert with check (requester_id = auth.uid());
-- WITH CHECK is deliberately NOT a copy of USING: a manager's own update
-- legitimately moves status FROM ('draft'/'returned_to_requester') TO
-- 'submitted', which the resulting (post-update) row would fail if WITH
-- CHECK required the same pre-update status list — Postgres defaults an
-- omitted WITH CHECK to mirror USING, which would silently reject every
-- legal transition. The transition's legality is already enforced by the
-- enforce_request_transition trigger above; this WITH CHECK only needs to
-- confirm the row still belongs to this manager.
create policy requests_manager_update on requests for update
  using (requester_id = auth.uid() and status in ('draft', 'returned_to_requester'))
  with check (requester_id = auth.uid());

create policy requests_hrbp_read on requests for select using (
  assigned_hrbp_id = auth.uid() and status <> 'draft'
);
-- Same reasoning as requests_manager_update above — HRBP's legal moves land
-- on 'od_review'/'returned_to_requester', neither of which is in the
-- pre-update USING list.
create policy requests_hrbp_update on requests for update
  using (assigned_hrbp_id = auth.uid() and status in ('submitted', 'hrbp_review', 'returned_to_hrbp'))
  with check (assigned_hrbp_id = auth.uid());

create policy requests_od_read on requests for select using (
  status in ('od_review', 'approved', 'rejected') or od_reviewed
);
-- OD doesn't own a column on the row (no assigned_od_id) — the transition's
-- legality and actor are fully enforced by the trigger, so WITH CHECK just
-- needs to not implicitly re-require status = 'od_review' post-update.
create policy requests_od_update on requests for update
  using (status = 'od_review')
  with check (true);

create policy requests_admin_read on requests for select using (is_admin(auth.uid()));

-- request_answers / request_history have no direct role/status columns of
-- their own — visibility follows whatever the parent request's OWN RLS
-- policies (above) already allow the current user to see. This subquery
-- runs under the querying user's RLS context (it's a plain subquery, not a
-- SECURITY DEFINER function), so it's correctly scoped per-user, not a
-- bypass.
create policy answers_follow_request on request_answers for select using (
  exists (select 1 from requests r where r.id = request_answers.request_id)
);
create policy history_follow_request on request_history for select using (
  exists (select 1 from requests r where r.id = request_history.request_id)
);

-- Row-level write access, matching each actor/status rule from the requests
-- policies above. This does NOT yet solve column-level privacy (e.g. a
-- Manager's UPDATE is only blocked from touching hrbp_verdict/hrbp_comment/
-- od_verdict/od_comment at the application layer, not by Postgres) — that
-- refinement is still deferred to Step 5/6, per the plan's design note 7,
-- once it's decided whether that's a view, column GRANTs, or app-only
-- enforcement. Without ANY policy here, though, these tables would be
-- completely unwritable, which blocks Step 4 (the request form) entirely —
-- so a row-level baseline is part of a complete Step 1.
create policy answers_manager_insert on request_answers for insert with check (
  exists (select 1 from requests r where r.id = request_id and r.requester_id = auth.uid())
);
create policy answers_manager_update on request_answers for update
  using (exists (
    select 1 from requests r where r.id = request_id and r.requester_id = auth.uid()
      and r.status in ('draft', 'returned_to_requester')
  ))
  with check (exists (select 1 from requests r where r.id = request_id and r.requester_id = auth.uid()));

create policy answers_hrbp_update on request_answers for update
  using (exists (
    select 1 from requests r where r.id = request_id and r.assigned_hrbp_id = auth.uid()
      and r.status in ('submitted', 'hrbp_review', 'returned_to_hrbp')
  ))
  with check (exists (select 1 from requests r where r.id = request_id and r.assigned_hrbp_id = auth.uid()));

create policy answers_od_update on request_answers for update
  using (exists (select 1 from requests r where r.id = request_id and r.status = 'od_review'))
  with check (true);

-- request_history is an append-only log; anyone may insert a row attributed
-- to themselves. It's not the source of truth for state (requests.status,
-- enforced by the trigger, is), so a permissive insert policy here is low-risk.
create policy history_insert on request_history for insert with check (actor_id = auth.uid());
