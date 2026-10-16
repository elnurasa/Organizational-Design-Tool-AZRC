-- =============================================================================
-- 0004_request_workflow_rpcs.sql
-- -----------------------------------------------------------------------------
-- Transactional operations for the Structural Change Request workflow.
--
-- Every multi-row/multi-table write in this workflow (a request + its answers
-- together, or a batch of verdicts + a status transition + a history entry)
-- goes through one of these functions instead of several separate client-side
-- calls, so a failure partway through can't leave the database in a half-
-- written state — a Postgres function body is one transaction.
--
-- All SECURITY INVOKER (not DEFINER): they run with the calling user's own
-- auth.uid() and are still subject to every RLS policy from 0003 — these
-- functions add transactional atomicity, not elevated privilege. That also
-- means the existing requests_enforce_transition trigger still validates
-- every status change made inside them.
--
-- Also fixes a gap from 0003: 'rejected' was a valid requests.status value
-- with no way to ever reach it. Adds od_review -> rejected (by od_team) to
-- the transition allow-list.
-- =============================================================================

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

-- ---------------------------------------------------------------------------
-- save_request_draft: create-or-update a request + fully replace its answer
-- set, in one transaction. Replacing (not merging) request_answers on every
-- save is what closes the "orphaned answers on category change" gap noted
-- in Step 1 — there is never a stale answer from a previous category
-- sitting alongside the current question set.
--
-- Only callable by the Manager who owns the request, and only while it's
-- still editable (draft or returned_to_requester) — enforced here directly
-- rather than relying solely on RLS, since this function's own UPDATE runs
-- as the function, not as a bare client statement RLS would otherwise gate
-- the same way.
-- ---------------------------------------------------------------------------
create function save_request_draft(
  p_request_id uuid,
  p_category text,
  p_change_description text,
  p_justification text,
  p_requested_effective_date date,
  p_assigned_hrbp_id uuid,
  p_answers jsonb
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_request_id uuid;
  v_status text;
begin
  if p_request_id is null then
    insert into requests (
      requester_id, status, category, change_description, justification,
      requested_effective_date, assigned_hrbp_id
    ) values (
      auth.uid(), 'draft', p_category, p_change_description, p_justification,
      p_requested_effective_date, p_assigned_hrbp_id
    )
    returning id into v_request_id;
  else
    select status into v_status from requests
      where id = p_request_id and requester_id = auth.uid();

    if v_status is null then
      raise exception 'Request not found.';
    end if;
    if v_status not in ('draft', 'returned_to_requester') then
      raise exception 'This request can no longer be edited.';
    end if;

    update requests set
      category = p_category,
      change_description = p_change_description,
      justification = p_justification,
      requested_effective_date = p_requested_effective_date,
      assigned_hrbp_id = p_assigned_hrbp_id
    where id = p_request_id;

    v_request_id := p_request_id;
    delete from request_answers where request_id = v_request_id;
  end if;

  insert into request_answers (request_id, question_key, question_text, answer, sort_order)
  select
    v_request_id,
    (a ->> 'question_key'),
    (a ->> 'question_text'),
    (a ->> 'answer'),
    coalesce((a ->> 'sort_order')::int, 0)
  from jsonb_array_elements(p_answers) as a;

  return v_request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_structural_request: transitions an existing draft/returned request
-- to 'submitted', snapshotting the requester's current profile onto the
-- request row at this exact moment (see 0003's design note on why this is a
-- snapshot, not a live join).
-- ---------------------------------------------------------------------------
create function submit_structural_request(p_request_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_requester users%rowtype;
  v_old_status text;
begin
  select status into v_old_status from requests
    where id = p_request_id and requester_id = auth.uid();

  if v_old_status is null then
    raise exception 'Request not found.';
  end if;
  if v_old_status not in ('draft', 'returned_to_requester') then
    raise exception 'This request has already been submitted.';
  end if;

  select * into v_requester from users where id = auth.uid();

  update requests set
    status = 'submitted',
    requester_full_name = v_requester.full_name,
    requester_company = v_requester.company,
    requester_job_title = v_requester.job_title,
    requester_division = v_requester.division,
    requester_department = v_requester.department,
    requester_subdepartment = v_requester.subdepartment,
    requester_unit = v_requester.unit,
    requester_subunit = v_requester.subunit,
    requester_email = v_requester.email
  where id = p_request_id;

  insert into request_history (request_id, actor_id, action, from_status, to_status)
    values (p_request_id, auth.uid(), 'submitted', v_old_status, 'submitted');
end;
$$;

-- ---------------------------------------------------------------------------
-- hrbp_submit_review: writes every per-answer verdict/comment and transitions
-- the request in one step — od_review if every answer is 'sufficient',
-- returned_to_requester otherwise. Covers both the first-time review
-- (status = 'hrbp_review') and the "fix and resubmit" path after OD sent it
-- back (status = 'returned_to_hrbp') — the outcome logic is identical either
-- way, only the starting status differs, and the trigger already accepts
-- both as valid sources for these two target statuses.
-- ---------------------------------------------------------------------------
create function hrbp_submit_review(
  p_request_id uuid,
  p_verdicts jsonb, -- [{ question_key, verdict, comment }]
  p_general_comment text
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_status text;
  v_new_status text;
  v_all_sufficient boolean;
begin
  select status into v_old_status from requests
    where id = p_request_id and assigned_hrbp_id = auth.uid();

  if v_old_status is null then
    raise exception 'Request not found or not assigned to you.';
  end if;
  if v_old_status not in ('hrbp_review', 'returned_to_hrbp') then
    raise exception 'This request is not awaiting your review.';
  end if;

  update request_answers ra set
    hrbp_verdict = (v ->> 'verdict'),
    hrbp_comment = (v ->> 'comment')
  from jsonb_array_elements(p_verdicts) as v
  where ra.request_id = p_request_id and ra.question_key = (v ->> 'question_key');

  select bool_and(hrbp_verdict = 'sufficient') into v_all_sufficient
    from request_answers where request_id = p_request_id;

  v_new_status := case when coalesce(v_all_sufficient, false) then 'od_review' else 'returned_to_requester' end;

  update requests set status = v_new_status where id = p_request_id;

  insert into request_history (request_id, actor_id, action, from_status, to_status, comment)
    values (
      p_request_id, auth.uid(),
      case when v_new_status = 'od_review' then 'forwarded_to_od' else 'returned_to_requester' end,
      v_old_status, v_new_status, p_general_comment
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- hrbp_mark_in_review: the "submitted -> hrbp_review" transition, fired
-- client-side the first time an HRBP opens a submitted request assigned to
-- them (see js/hrbp-review.js) — this is what "auto on submit, or manual
-- HRBP pickup" resolves to: opening the review is the pickup, no separate
-- button. A plain guarded UPDATE (not a full RPC) would work too, but this
-- keeps the "not yet claimed vs currently under review" distinction (used
-- for the inbox's "New" badge) as one clearly-named operation.
-- ---------------------------------------------------------------------------
create function hrbp_mark_in_review(p_request_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  update requests
  set status = 'hrbp_review'
  where id = p_request_id and assigned_hrbp_id = auth.uid() and status = 'submitted';
  -- No matching row (already picked up, not assigned to caller, etc.) is not
  -- an error — this is a best-effort "mark as opened", not a user action.
end;
$$;

-- ---------------------------------------------------------------------------
-- od_submit_review: OD's equivalent of hrbp_submit_review — approve, reject
-- outright, or return to HRBP.
-- ---------------------------------------------------------------------------
create function od_submit_review(
  p_request_id uuid,
  p_decision text, -- 'approve' | 'reject' | 'return_to_hrbp'
  p_verdicts jsonb, -- [{ question_key, verdict, comment }]
  p_general_comment text
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_status text;
  v_new_status text;
begin
  if p_decision not in ('approve', 'reject', 'return_to_hrbp') then
    raise exception 'Unknown decision.';
  end if;

  select status into v_old_status from requests where id = p_request_id;
  if v_old_status is null then
    raise exception 'Request not found.';
  end if;
  if v_old_status <> 'od_review' then
    raise exception 'This request is not awaiting OD review.';
  end if;

  update request_answers ra set
    od_verdict = (v ->> 'verdict'),
    od_comment = (v ->> 'comment')
  from jsonb_array_elements(p_verdicts) as v
  where ra.request_id = p_request_id and ra.question_key = (v ->> 'question_key');

  v_new_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    else 'returned_to_hrbp'
  end;

  update requests set status = v_new_status where id = p_request_id;

  insert into request_history (request_id, actor_id, action, from_status, to_status, comment)
    values (p_request_id, auth.uid(), p_decision, v_old_status, v_new_status, p_general_comment);
end;
$$;
