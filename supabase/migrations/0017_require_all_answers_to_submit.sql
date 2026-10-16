-- 0017_require_all_answers_to_submit.sql
-- ---------------------------------------------------------------------------
-- Every question of a request is required: a request cannot be submitted (or
-- resubmitted after being returned) unless every one of its answers has a
-- written answer.
--
-- The request form already refuses to move on or to submit while a question
-- is empty. That check lives in the browser, though, and anyone can call the
-- submit_structural_request() function directly, so the rule is also enforced
-- here, where it cannot be skipped. A request with no answer rows at all is
-- refused too (every category has at least one question).
--
-- Saving a DRAFT is unchanged: a draft may be incomplete — only submitting is
-- gated.
--
-- Same signature as 0005 (uuid) — CREATE OR REPLACE swaps the body in place;
-- everything except the new check, including the error wording, is 0005's.
--
-- Run once in the Supabase Dashboard -> SQL Editor (after 0016). Safe to re-run.
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

  if not exists (select 1 from request_answers where request_id = p_request_id)
     or exists (
       select 1 from request_answers
       where request_id = p_request_id and coalesce(answer, '') ~ '^\s*$'
     ) then
    raise exception 'Every question must be answered before the request can be submitted.';
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

notify pgrst, 'reload schema';
