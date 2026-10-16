-- reset_request_data.sql
-- ---------------------------------------------------------------------------
-- ONE-OFF CLEAN-UP, not a migration (it lives in supabase/maintenance/, not in
-- supabase/migrations/, and must NOT be run as part of the setup order).
--
-- Deletes every request and everything that hangs off it, for all users, so the
-- tool starts clean:
--
--   requests               every request (drafts, in review, approved, ...)
--   request_answers        their answers            (deleted with the request)
--   request_history        their approval trail     (deleted with the request)
--   hrbp_verdict_history   HRBP per-question rounds (deleted with the request)
--   od_verdict_history     OD per-question rounds   (deleted with the request)
--
-- and restarts the request numbering, so the first new request is ORG-0001.
--
-- NOT touched: user accounts and roles (auth.users, users, managers, hrbps, od,
-- admin_permissions) and every setting. Everyone keeps their login.
--
-- THIS CANNOT BE UNDONE. There is no backup (by decision). Run it once, in the
-- Supabase Dashboard -> SQL Editor, at the moment you hand the tool to the
-- users. It is a single transaction: if anything fails, nothing is deleted.
--
-- The result you get back is one row of counts: the "before" numbers are what
-- was deleted, the "after" numbers must all be 0.
-- ---------------------------------------------------------------------------

begin;

create temp table _reset_counts as
select
  (select count(*) from requests)             as requests_before,
  (select count(*) from request_answers)      as answers_before,
  (select count(*) from request_history)      as history_before,
  (select count(*) from hrbp_verdict_history) as hrbp_rounds_before,
  (select count(*) from od_verdict_history)   as od_rounds_before;

-- The four child tables are "on delete cascade" from requests.
delete from requests where true;

alter sequence requests_request_number_seq restart with 1;

commit;

-- (a transaction ends before this, so the counts below are the committed state)
select
  c.*,
  (select count(*) from requests)             as requests_after,
  (select count(*) from request_answers)      as answers_after,
  (select count(*) from request_history)      as history_after,
  (select count(*) from hrbp_verdict_history) as hrbp_rounds_after,
  (select count(*) from od_verdict_history)   as od_rounds_after,
  (select count(*) from users)                as users_kept
from _reset_counts c;
