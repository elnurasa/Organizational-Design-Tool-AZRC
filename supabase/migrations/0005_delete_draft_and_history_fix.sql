-- =============================================================================
-- 0005_delete_draft_and_history_fix.sql
-- -----------------------------------------------------------------------------
-- Two gaps found while migrating the finished UI/UX mock layer (js/mock-
-- data.js, js/request-service.js) onto this real schema:
--
-- 1. No DELETE policy exists anywhere on requests/request_answers/
--    request_history. The mock's deleteDraftRequest() (manager-requests.js's
--    "Delete Draft" action) has no real-schema equivalent it could call —
--    RLS would reject the DELETE outright. Adds policies scoped exactly the
--    same way the mock does: requester's own request, status = 'draft' only.
--    (request_answers/request_history need their own DELETE policies too,
--    not just a FK ON DELETE CASCADE from requests — a cascade delete on a
--    referencing table is still subject to that table's own RLS.)
--
-- 2. The mock's saveRequestDraft() inserts a request_history row
--    (action: 'created') the first time a manager saves a brand-new draft,
--    so the Approval Trail always has a starting entry. 0004's
--    save_request_draft() RPC never did this. Re-created here (CREATE OR
--    REPLACE) to match, so the Approval Trail looks identical either way.
--
-- 3. Wording parity: js/request-service.js's mock functions and 0004's RPCs
--    were written independently and ended up with slightly different error
--    text for the same failure ("Request not found." vs "This request
--    could not be found.", and hrbp_submit_review's extra "or not assigned
--    to you" clause). Since the frontend surfaces these messages verbatim
--    to the user, re-creating all four affected functions here so the text
--    is byte-identical to what the UI showed before this migration —
--    otherwise the migration would be a visible behavior change, which it
--    must not be.
-- =============================================================================

create policy requests_manager_delete_draft on requests for delete using (
  requester_id = auth.uid() and status = 'draft'
);

create policy answers_delete_with_draft_request on request_answers for delete using (
  exists (
    select 1 from requests r
    where r.id = request_id and r.requester_id = auth.uid() and r.status = 'draft'
  )
);

create policy history_delete_with_draft_request on request_history for delete using (
  exists (
    select 1 from requests r
    where r.id = request_id and r.requester_id = auth.uid() and r.status = 'draft'
  )
);

create or replace function save_request_draft(
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

    insert into request_history (request_id, actor_id, action, from_status, to_status)
      values (v_request_id, auth.uid(), 'created', null, 'draft');
  else
    select status into v_status from requests
      where id = p_request_id and requester_id = auth.uid();

    if v_status is null then
      raise exception 'This request could not be found.';
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
-- Wording-parity re-creates (see note 3 above) — logic identical to 0004's
-- versions, only the raised exception text changed.
-- ---------------------------------------------------------------------------
create or replace function submit_structural_request(p_request_id uuid)
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
    raise exception 'This request could not be found.';
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

create or replace function hrbp_submit_review(
  p_request_id uuid,
  p_verdicts jsonb,
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
    raise exception 'This request could not be found.';
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

create or replace function od_submit_review(
  p_request_id uuid,
  p_decision text,
  p_verdicts jsonb,
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
    raise exception 'This request could not be found.';
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
