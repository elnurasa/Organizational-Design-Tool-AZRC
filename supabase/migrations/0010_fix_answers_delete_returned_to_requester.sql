-- 0010_fix_answers_delete_returned_to_requester.sql
-- ---------------------------------------------------------------------------
-- BUG: editing and re-saving a `returned_to_requester` request failed with
-- "duplicate key value violates unique constraint
-- request_answers_request_id_question_key_key".
--
-- Root cause: save_request_draft() (0004/0005) is SECURITY INVOKER, so its
-- `delete from request_answers where request_id = v_request_id` runs under
-- the CALLER's own RLS — and answers_delete_with_draft_request (0005), the
-- only DELETE policy on request_answers, only permits deletion when the
-- parent request's status = 'draft'. save_request_draft() itself explicitly
-- allows re-editing a 'returned_to_requester' request too (see its own
-- status check), but the delete silently affected zero rows in that case
-- (RLS filters non-matching rows out rather than erroring), leaving the old
-- answer rows in place. The following insert of the same question_keys then
-- collided with them.
--
-- Fix: widen the DELETE policy to match the exact same status set
-- save_request_draft()/requests_manager_update already allow for editing —
-- 'draft' and 'returned_to_requester'.
-- ---------------------------------------------------------------------------

drop policy if exists answers_delete_with_draft_request on request_answers;

create policy answers_delete_with_draft_request on request_answers for delete using (
  exists (
    select 1 from requests r
    where r.id = request_id and r.requester_id = auth.uid()
      and r.status in ('draft', 'returned_to_requester')
  )
);

notify pgrst, 'reload schema';
