-- =============================================================================
-- 0001_admin_panel.sql
-- -----------------------------------------------------------------------------
-- Schema for the Organizational Design Tool's Admin Panel.
--
-- Replaces the Google Sheet as the system of record for Managers/HRBPs/OD.
-- Supabase Auth (auth.users) remains the ONLY place a password or its hash is
-- ever stored — these tables only hold a reference (auth_user_id) to the
-- matching Auth user. All writes to these tables happen exclusively through
-- the Apps Script Web App (apps-script/Code.gs) using the service_role key,
-- which bypasses Row Level Security below by design — the RLS policies here
-- exist to gate direct browser reads (via the anon/authenticated key) to
-- Admins only.
--
-- Run this once in the Supabase Dashboard -> SQL Editor. Safe to re-run only
-- after dropping the objects it creates; it is not written to be idempotent.
-- =============================================================================

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Managers
-- ---------------------------------------------------------------------------
create table managers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  job_title text not null,
  division text not null,
  department text not null,
  subdepartment text,
  unit text,
  subunit text,
  mail text not null unique,
  account text not null unique,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index managers_full_name_trgm_idx on managers using gin (full_name gin_trgm_ops);
create index managers_division_idx on managers (division);
create index managers_department_idx on managers (department);

-- ---------------------------------------------------------------------------
-- HRBPs
-- ---------------------------------------------------------------------------
create table hrbps (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  job_title text not null,
  mail text not null unique,
  account text not null unique,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index hrbps_full_name_trgm_idx on hrbps using gin (full_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- OD
-- ---------------------------------------------------------------------------
create table od (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  job_title text not null,
  mail text not null unique,
  account text not null unique,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index od_full_name_trgm_idx on od using gin (full_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Admin permissions — orthogonal to the Manager/HRBP/OD role. Keyed by the
-- Supabase Auth user id, which every row above carries once an Admin creates
-- the account, so this works uniformly across all three tables.
-- ---------------------------------------------------------------------------
create table admin_permissions (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Admin Profiles view: every employee across all three tables, tagged with
-- their role. security_invoker means it runs with the QUERYING user's RLS
-- permissions (not the view owner's), so the same "Admins only" policies on
-- managers/hrbps/od apply to reads through this view too.
-- ---------------------------------------------------------------------------
create view admin_all_employees
  with (security_invoker = true) as
  select id, full_name, job_title, mail, 'Manager'::text as role, auth_user_id from managers
  union all
  select id, full_name, job_title, mail, 'HRBP'::text as role, auth_user_id from hrbps
  union all
  select id, full_name, job_title, mail, 'OD'::text as role, auth_user_id from od;

-- ---------------------------------------------------------------------------
-- is_admin(uid): SECURITY DEFINER so RLS policies on managers/hrbps/od/
-- admin_permissions can check admin status without recursing into
-- admin_permissions' own RLS.
-- ---------------------------------------------------------------------------
create function is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from admin_permissions
    where auth_user_id = uid and is_admin
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security. Deliberately NO insert/update/delete policies on any
-- of these tables for the anon/authenticated roles — every write goes
-- through Code.gs with the service_role key, which bypasses RLS entirely.
-- That means even a client that bypasses the Admin Panel UI and calls
-- Supabase directly can, at most, read data it's an Admin for; it can never
-- write.
-- ---------------------------------------------------------------------------
alter table managers enable row level security;
alter table hrbps enable row level security;
alter table od enable row level security;
alter table admin_permissions enable row level security;

create policy admin_read on managers for select using (is_admin(auth.uid()));
create policy admin_read on hrbps for select using (is_admin(auth.uid()));
create policy admin_read on od for select using (is_admin(auth.uid()));

-- A signed-in user may always read their OWN admin_permissions row (needed
-- so any dashboard can show/hide the "Admin Panel" link and so admin.html's
-- own page guard can check "am I an admin" with a plain client-side read);
-- Admins may read everyone's.
create policy self_or_admin_read on admin_permissions for select
  using (auth_user_id = auth.uid() or is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger managers_set_updated_at
  before update on managers
  for each row execute function set_updated_at();

create trigger hrbps_set_updated_at
  before update on hrbps
  for each row execute function set_updated_at();

create trigger od_set_updated_at
  before update on od
  for each row execute function set_updated_at();
