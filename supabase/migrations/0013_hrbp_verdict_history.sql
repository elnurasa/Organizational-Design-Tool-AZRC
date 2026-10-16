-- 0013_hrbp_verdict_history.sql
-- ---------------------------------------------------------------------------
-- Every "insufficient" decision an HRBP makes must stay visible as history
-- when the request later reaches OD.
--
-- Why it was lost: an HRBP's per-answer verdict + comment live on
-- request_answers.hrbp_verdict / hrbp_comment. When the requester fixes a
-- returned request, save_request_draft() deletes and re-inserts every answer
-- row, so the old verdicts (and the old answer text they were about) were
-- gone by the time the request reached OD — only the single general comment
-- survived in request_history.
--
-- Fix: an append-only table. hrbp_submit_review() now copies each answer the
-- HRBP marked insufficient — with the answer text as it stood at that
-- moment, the HRBP's comment, the review round and where the request went —
-- into hrbp_verdict_history before anything can overwrite it. Only
-- insufficient decisions are recorded; sufficient ones need no history.
--
-- The table has no UPDATE or DELETE policy, so rows are immutable. It is
-- readable by whoever can read the parent request (requester, assigned HRBP,
-- OD once it reaches them, Admin) — same rule as request_answers.
--
-- Depends on request_answers.selected_options (0012). The column is added
-- here too with IF NOT EXISTS so this migration also works on its own.
-- ---------------------------------------------------------------------------

alter table request_answers
  add column if not exists selected_options text[] not null default '{}';

create table if not exists hrbp_verdict_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  review_round int not null,
  hrbp_id uuid not null references users(id),
  question_key text not null,
  question_text text not null,
  answer text,
  selected_options text[] not null default '{}',
  comment text,
  sort_order int not null default 0,
  outcome text not null check (outcome in ('od_review', 'returned_to_requester')),
  created_at timestamptz not null default now()
);

create index if not exists hrbp_verdict_history_request_idx
  on hrbp_verdict_history (request_id, review_round, sort_order);

alter table hrbp_verdict_history enable row level security;

drop policy if exists hrbp_verdict_history_read on hrbp_verdict_history;
create policy hrbp_verdict_history_read on hrbp_verdict_history for select using (
  exists (select 1 from requests r where r.id = hrbp_verdict_history.request_id)
);

drop policy if exists hrbp_verdict_history_insert on hrbp_verdict_history;
create policy hrbp_verdict_history_insert on hrbp_verdict_history for insert with check (
  hrbp_id = auth.uid()
  and exists (
    select 1 from requests r
    where r.id = hrbp_verdict_history.request_id and r.assigned_hrbp_id = auth.uid()
  )
);

-- Same signature as 0006 (uuid, jsonb, text, text) — CREATE OR REPLACE swaps
-- the body in place, no second overload is created.
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
  v_round int;
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

  -- Keep every insufficient decision as permanent history, with the answer
  -- exactly as the HRBP saw it, before the requester can replace it.
  select coalesce(max(review_round), 0) + 1 into v_round
    from hrbp_verdict_history where request_id = p_request_id;

  insert into hrbp_verdict_history (
    request_id, review_round, hrbp_id, question_key, question_text,
    answer, selected_options, comment, sort_order, outcome
  )
  select
    p_request_id, v_round, auth.uid(), ra.question_key, ra.question_text,
    ra.answer, ra.selected_options, ra.hrbp_comment, ra.sort_order, v_new_status
  from request_answers ra
  where ra.request_id = p_request_id and ra.hrbp_verdict = 'insufficient';

  update requests set status = v_new_status where id = p_request_id;

  insert into request_history (request_id, actor_id, action, from_status, to_status, comment)
    values (
      p_request_id, auth.uid(),
      case when v_new_status = 'od_review' then 'forwarded_to_od' else 'returned_to_requester' end,
      v_old_status, v_new_status, p_general_comment
    );
end;
$$;

-- Backfill: requests that already have insufficient verdicts on their current
-- answers (typically ones sitting in "Returned to Requester" right now) would
-- lose them the moment the requester edits. Capture them as round 1. Earlier
-- rounds that were already overwritten before this migration cannot be
-- recovered. The NOT EXISTS guard makes re-running this safe.
insert into hrbp_verdict_history (
  request_id, review_round, hrbp_id, question_key, question_text,
  answer, selected_options, comment, sort_order, outcome, created_at
)
select
  ra.request_id, 1, r.assigned_hrbp_id, ra.question_key, ra.question_text,
  ra.answer, ra.selected_options, ra.hrbp_comment, ra.sort_order,
  case when r.status = 'returned_to_requester' then 'returned_to_requester' else 'od_review' end,
  coalesce(
    (select max(h.created_at) from request_history h
       where h.request_id = r.id and h.action in ('returned_to_requester', 'forwarded_to_od')),
    r.updated_at
  )
from request_answers ra
join requests r on r.id = ra.request_id
where ra.hrbp_verdict = 'insufficient'
  and r.assigned_hrbp_id is not null
  and not exists (select 1 from hrbp_verdict_history x where x.request_id = ra.request_id);

notify pgrst, 'reload schema';
