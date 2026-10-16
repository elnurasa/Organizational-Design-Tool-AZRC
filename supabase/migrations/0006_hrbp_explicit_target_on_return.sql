-- =============================================================================
-- 0006_hrbp_explicit_target_on_return.sql
-- -----------------------------------------------------------------------------
-- Previously, hrbp_submit_review() always derived the outcome purely from the
-- per-answer verdicts: all-sufficient -> forwarded to OD, any-insufficient ->
-- returned to the requester. The "Return to Requester" / "Submit to OD"
-- buttons existed but were really just a preview of that automatic outcome —
-- an HRBP could never send a request to whichever destination they wanted.
--
-- New behavior, scoped only to a request OD has already sent back to HRBP
-- (status 'returned_to_hrbp'): once every answer has a verdict, HRBP may pick
-- either destination directly, regardless of what the verdicts imply. The
-- ordinary first-time review (status 'hrbp_review') is unchanged — outcome is
-- still fully determined by the verdicts, no manual override.
-- =============================================================================

create or replace function hrbp_submit_review(
  p_request_id uuid,
  p_verdicts jsonb,
  p_general_comment text,
  p_target text default null -- 'od_review' | 'returned_to_requester' — only honored when old status = 'returned_to_hrbp'
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

  if v_old_status = 'returned_to_hrbp' and p_target in ('od_review', 'returned_to_requester') then
    v_new_status := p_target;
  else
    v_new_status := case when coalesce(v_all_sufficient, false) then 'od_review' else 'returned_to_requester' end;
  end if;

  update requests set status = v_new_status where id = p_request_id;

  insert into request_history (request_id, actor_id, action, from_status, to_status, comment)
    values (
      p_request_id, auth.uid(),
      case when v_new_status = 'od_review' then 'forwarded_to_od' else 'returned_to_requester' end,
      v_old_status, v_new_status, p_general_comment
    );
end;
$$;
