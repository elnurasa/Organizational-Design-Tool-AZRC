-- 0014_od_verdict_history.sql
-- ---------------------------------------------------------------------------
-- Every "insufficient" decision an OD team member makes must stay on record,
-- exactly like HRBP's already do (0013).
--
-- Why it was lost: OD's per-answer verdict + comment live on
-- request_answers.od_verdict / od_comment. They were overwritten by the next
-- OD review of the same request, and wiped completely when the requester
-- fixed a returned request (save_request_draft() deletes and re-inserts every
-- answer row). After an OD -> HRBP -> requester -> HRBP -> OD loop, only the
-- single general comment in request_history survived; what OD actually wrote
-- about each answer was gone for good.
--
-- Fix: an append-only table. od_submit_review() now copies each answer OD
-- marked insufficient — with the answer text as it stood at that moment, OD's
-- comment, the review round and what OD decided — into od_verdict_history
-- before anything can overwrite it. Only insufficient decisions are recorded;
-- sufficient ones need no history.
--
-- Who may read it: the assigned HRBP, the OD team and Admins — NOT the
-- requester. What OD and HRBP say to each other about an answer is not
-- addressed to the requester, so this is enforced by Row Level Security here,
-- not only hidden in the page (js/workflow-shared.js verdictHistoryForRequester
-- is a second, UI-level layer).
--
-- The table has no UPDATE or DELETE policy, so rows are immutable.
--
-- Run this once in the Supabase Dashboard -> SQL Editor (after 0013).
-- Safe to re-run.
-- ---------------------------------------------------------------------------

-- is_od_team(uid): SECURITY DEFINER for the same reason is_admin() is (0001) —
-- a policy on requests / request_answers / this table can check "is this an
-- OD team member" without re-entering the users table's own RLS policy
-- (users_read looks at requests, requests policies would look at users).
create or replace function is_od_team(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from users where id = uid and role = 'od_team'
  );
$$;

create table if not exists od_verdict_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  review_round int not null,
  od_id uuid not null references users(id),
  question_key text not null,
  question_text text not null,
  answer text,
  selected_options text[] not null default '{}',
  comment text,
  sort_order int not null default 0,
  outcome text not null check (outcome in ('returned_to_hrbp', 'rejected', 'approved')),
  created_at timestamptz not null default now(),
  unique (request_id, review_round, question_key)
);

create index if not exists od_verdict_history_request_idx
  on od_verdict_history (request_id, review_round, sort_order);

alter table od_verdict_history enable row level security;

drop policy if exists od_verdict_history_read on od_verdict_history;
create policy od_verdict_history_read on od_verdict_history for select using (
  is_admin(auth.uid())
  or is_od_team(auth.uid())
  or exists (
    select 1 from requests r
    where r.id = od_verdict_history.request_id
      and r.assigned_hrbp_id = auth.uid()
      and r.status <> 'draft'
  )
);

drop policy if exists od_verdict_history_insert on od_verdict_history;
create policy od_verdict_history_insert on od_verdict_history for insert with check (
  od_id = auth.uid() and is_od_team(auth.uid())
);

-- Same signature as 0005 (uuid, text, jsonb, text) — CREATE OR REPLACE swaps
-- the body in place, no second overload is created. Everything except the
-- archive step is unchanged, including the error wording.
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
  v_round int;
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

  -- Keep every insufficient decision as permanent history, with the answer
  -- exactly as OD saw it, before the next review or the requester's edit can
  -- replace it.
  select coalesce(max(review_round), 0) + 1 into v_round
    from od_verdict_history where request_id = p_request_id;

  insert into od_verdict_history (
    request_id, review_round, od_id, question_key, question_text,
    answer, selected_options, comment, sort_order, outcome
  )
  select
    p_request_id, v_round, auth.uid(), ra.question_key, ra.question_text,
    ra.answer, ra.selected_options, ra.od_comment, ra.sort_order, v_new_status
  from request_answers ra
  where ra.request_id = p_request_id and ra.od_verdict = 'insufficient';

  update requests set status = v_new_status where id = p_request_id;

  insert into request_history (request_id, actor_id, action, from_status, to_status, comment)
    values (p_request_id, auth.uid(), p_decision, v_old_status, v_new_status, p_general_comment);
end;
$$;

-- Backfill: requests that already carry an insufficient OD verdict on their
-- current answers (typically one OD just sent back to HRBP) would lose it at
-- the next OD review or requester edit. Capture it as round 1, dated and
-- attributed from the matching return/reject entry in request_history.
-- Earlier rounds that were already overwritten before this migration cannot
-- be recovered. The NOT EXISTS guard makes re-running this safe.
insert into od_verdict_history (
  request_id, review_round, od_id, question_key, question_text,
  answer, selected_options, comment, sort_order, outcome, created_at
)
select
  ra.request_id, 1, h.actor_id, ra.question_key, ra.question_text,
  ra.answer, ra.selected_options, ra.od_comment, ra.sort_order,
  case when h.action = 'reject' then 'rejected' else 'returned_to_hrbp' end,
  h.created_at
from request_answers ra
join lateral (
  select rh.actor_id, rh.action, rh.created_at
  from request_history rh
  where rh.request_id = ra.request_id
    and rh.action in ('return_to_hrbp', 'reject')
    and rh.actor_id is not null
  order by rh.created_at desc
  limit 1
) h on true
where ra.od_verdict = 'insufficient'
  and not exists (select 1 from od_verdict_history x where x.request_id = ra.request_id);

notify pgrst, 'reload schema';
