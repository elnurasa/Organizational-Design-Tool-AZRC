-- 0012_answer_selected_options.sql
-- ---------------------------------------------------------------------------
-- Questions that offer predefined options (see `hints` in
-- js/request-questions.js) now let the requester pick several of them from a
-- searchable dropdown, show the picks as chips, and write a free-text
-- description separately. The picks used to be pasted into the answer text;
-- they are now stored as their own column so the description stays clean and
-- HRBP / OD / the PDF export can show options and description separately.
--
-- Existing answers are unaffected: selected_options defaults to an empty
-- array, so old rows simply have no picks and keep their text as-is.
--
-- save_request_draft() keeps its exact signature (only the body changes), so
-- CREATE OR REPLACE is enough — no overload is left behind.
-- ---------------------------------------------------------------------------

alter table request_answers
  add column if not exists selected_options text[] not null default '{}';

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

  insert into request_answers (request_id, question_key, question_text, answer, selected_options, sort_order)
  select
    v_request_id,
    (a ->> 'question_key'),
    (a ->> 'question_text'),
    (a ->> 'answer'),
    coalesce(array(select jsonb_array_elements_text(a -> 'selected_options')), '{}'::text[]),
    coalesce((a ->> 'sort_order')::int, 0)
  from jsonb_array_elements(p_answers) as a;

  return v_request_id;
end;
$$;

notify pgrst, 'reload schema';
