-- 0015_lock_down_request_edits.sql
-- ---------------------------------------------------------------------------
-- Closes the "anyone can edit a request while it is with OD" hole, and the
-- same class of hole at every other stage.
--
-- What was wrong (0003):
--   * requests_od_update  was USING (status = 'od_review') WITH CHECK (true) —
--     no role check at all. While a request sat in od_review, EVERY user who
--     could see it (its own requester, its assigned HRBP) passed that policy
--     and, because WITH CHECK was true, could rewrite ANY column: the change
--     description, the justification, assigned_hrbp_id, even requester_id
--     (moving the request out of their own list). Only `status` was guarded,
--     by the transition trigger.
--   * answers_od_update   had the same shape for request_answers: any user who
--     could see the request could rewrite any answer's text or any verdict.
--   * answers_manager_insert had no status condition, so a requester could add
--     answer rows to a request that was already with HRBP or OD.
--   * Row Level Security decides which ROWS a user may touch, never which
--     COLUMNS — 0003 noted this and deferred it ("app-only enforcement").
--     Nothing stopped a requester writing hrbp_verdict / od_verdict, or an
--     HRBP writing a requester's answer text, by calling the API directly.
--
-- Fix, in two layers (the app's own RPCs and pages are unaffected — they
-- already only do what is allowed below):
--   1. Policies: the OD update policies now require an actual OD team member.
--      Inserting an answer requires the request to be editable by its requester.
--      (Also re-states requests_od_read without the users-table lookup that
--      made it recurse with 0008's users_read — same rule, see below.)
--   2. Column guards (BEFORE triggers), which is where the real rule lives:
--        requests
--          - id, requester_id, request_number, created_at, od_reviewed,
--            submitted_at, resolved_at: never changeable by a user (the
--            transition trigger sets the last three itself, afterwards).
--          - the request's content (category, description, justification,
--            effective date, assigned HRBP, requester snapshot): only by its
--            requester, and only while it is a draft or returned to them.
--          - status: unchanged — still the transition trigger (0007).
--        request_answers
--          - answer text / options / order / question: only by the requester,
--            only while draft or returned to them.
--          - hrbp_verdict, hrbp_comment: only by the assigned HRBP, only while
--            the request is submitted / in HRBP review / returned to HRBP.
--          - od_verdict, od_comment: only by an OD team member, only while the
--            request is in od_review.
--          - a new answer row: only by the requester, only while editable,
--            and with no reviewer verdicts on it.
--
-- Callers with no end-user identity (auth.uid() is null: the SQL editor, a
-- migration, the service_role key used by the admin-api Edge Function) are
-- not restricted by the guards, so maintenance and backfills still work.
--
-- Run this once in the Supabase Dashboard -> SQL Editor (after 0014, which
-- defines is_od_team()). Safe to re-run.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Policies
-- ---------------------------------------------------------------------------

-- Same rule as 0009 (OD team members see requests that are or were in OD
-- review), written without querying the users table. 0009's version did, and
-- users_read (0008) in turn queries requests, so with both migrations applied
-- Postgres refuses every query on requests with "infinite recursion detected
-- in policy for relation requests". Going through the SECURITY DEFINER
-- is_od_team() (0014) breaks that cycle and changes nothing about who sees what.
drop policy if exists requests_od_read on requests;
create policy requests_od_read on requests for select using (
  (status in ('od_review', 'approved', 'rejected') or od_reviewed)
  and is_od_team(auth.uid())
);

drop policy if exists requests_od_update on requests;
create policy requests_od_update on requests for update
  using (status = 'od_review' and is_od_team(auth.uid()))
  with check (is_od_team(auth.uid()));

drop policy if exists answers_od_update on request_answers;
create policy answers_od_update on request_answers for update
  using (
    is_od_team(auth.uid())
    and exists (select 1 from requests r where r.id = request_id and r.status = 'od_review')
  )
  with check (is_od_team(auth.uid()));

drop policy if exists answers_manager_insert on request_answers;
create policy answers_manager_insert on request_answers for insert with check (
  exists (
    select 1 from requests r
    where r.id = request_id and r.requester_id = auth.uid()
      and r.status in ('draft', 'returned_to_requester')
  )
);

-- ---------------------------------------------------------------------------
-- 2a. requests: column guard
-- SECURITY DEFINER so it can read the caller's role without going through
-- the users table's own RLS. auth.uid() still resolves to the caller.
-- Trigger name sorts before requests_enforce_transition on purpose: this one
-- must see exactly what the client sent, before the transition trigger
-- legitimately fills in od_reviewed / submitted_at / resolved_at.
-- ---------------------------------------------------------------------------
create or replace function guard_request_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.requester_id is distinct from old.requester_id
     or new.request_number is distinct from old.request_number
     or new.created_at is distinct from old.created_at
     or new.od_reviewed is distinct from old.od_reviewed
     or new.submitted_at is distinct from old.submitted_at
     or new.resolved_at is distinct from old.resolved_at then
    raise exception 'These request fields are managed by the system and cannot be changed.';
  end if;

  if (
       new.category is distinct from old.category
    or new.change_description is distinct from old.change_description
    or new.justification is distinct from old.justification
    or new.requested_effective_date is distinct from old.requested_effective_date
    or new.assigned_hrbp_id is distinct from old.assigned_hrbp_id
    or new.requester_full_name is distinct from old.requester_full_name
    or new.requester_company is distinct from old.requester_company
    or new.requester_job_title is distinct from old.requester_job_title
    or new.requester_division is distinct from old.requester_division
    or new.requester_department is distinct from old.requester_department
    or new.requester_subdepartment is distinct from old.requester_subdepartment
    or new.requester_unit is distinct from old.requester_unit
    or new.requester_subunit is distinct from old.requester_subunit
    or new.requester_email is distinct from old.requester_email
  ) and not coalesce(
    old.requester_id = auth.uid() and old.status in ('draft', 'returned_to_requester'),
    false
  ) then
    raise exception 'This request can only be edited by its requester while it is a draft or has been returned to them.';
  end if;

  return new;
end;
$$;

drop trigger if exists requests_a_guard_columns on requests;
create trigger requests_a_guard_columns
  before update on requests
  for each row execute function guard_request_columns();

-- ---------------------------------------------------------------------------
-- 2b. request_answers: column guard (INSERT and UPDATE)
-- ---------------------------------------------------------------------------
create or replace function guard_answer_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_requester uuid;
  v_hrbp uuid;
  v_role text;
  v_requester_can_edit boolean;
begin
  if v_uid is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.request_id is distinct from old.request_id then
    raise exception 'An answer cannot be moved to another request.';
  end if;

  select status, requester_id, assigned_hrbp_id
    into v_status, v_requester, v_hrbp
    from requests where id = new.request_id;
  select role into v_role from users where id = v_uid;

  v_requester_can_edit := coalesce(
    v_requester = v_uid and v_status in ('draft', 'returned_to_requester'),
    false
  );

  if tg_op = 'INSERT' then
    if not v_requester_can_edit then
      raise exception 'Answers can only be added by the requester while the request is a draft or has been returned to them.';
    end if;
    if new.hrbp_verdict is not null or new.hrbp_comment is not null
       or new.od_verdict is not null or new.od_comment is not null then
      raise exception 'Reviewer verdicts cannot be set on a new answer.';
    end if;
    return new;
  end if;

  if (
       new.question_key is distinct from old.question_key
    or new.question_text is distinct from old.question_text
    or new.answer is distinct from old.answer
    or new.selected_options is distinct from old.selected_options
    or new.sort_order is distinct from old.sort_order
  ) and not v_requester_can_edit then
    raise exception 'An answer can only be edited by its requester while the request is a draft or has been returned to them.';
  end if;

  if (
       new.hrbp_verdict is distinct from old.hrbp_verdict
    or new.hrbp_comment is distinct from old.hrbp_comment
  ) and not coalesce(
    v_role = 'hrbp' and v_hrbp = v_uid and v_status in ('submitted', 'hrbp_review', 'returned_to_hrbp'),
    false
  ) then
    raise exception 'HRBP verdicts can only be set by the assigned HRBP while the request is under HRBP review.';
  end if;

  if (
       new.od_verdict is distinct from old.od_verdict
    or new.od_comment is distinct from old.od_comment
  ) and not coalesce(
    v_role = 'od_team' and v_status = 'od_review',
    false
  ) then
    raise exception 'OD verdicts can only be set by the OD team while the request is in OD review.';
  end if;

  return new;
end;
$$;

drop trigger if exists request_answers_guard_columns on request_answers;
create trigger request_answers_guard_columns
  before insert or update on request_answers
  for each row execute function guard_answer_columns();

notify pgrst, 'reload schema';
