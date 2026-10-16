-- 0011_request_number.sql
-- ---------------------------------------------------------------------------
-- Human-friendly request identifier. requests.id stays the UUID primary key
-- (used in URLs, RPC parameters and every foreign key) — this adds a plain
-- sequential request_number beside it, shown in the UI as "REQ-0001" instead
-- of a 36-character UUID.
--
-- Existing requests are numbered 1..N in the order they were created. The
-- requests_set_updated_at trigger is switched off for that one backfill
-- UPDATE, otherwise every request's updated_at would jump to "now" and the
-- inboxes (ordered by updated_at) would reshuffle.
-- ---------------------------------------------------------------------------

alter table requests add column if not exists request_number bigint;

alter table requests disable trigger requests_set_updated_at;

with numbered as (
  select id, row_number() over (order by created_at, id) as n
  from requests
  where request_number is null
)
update requests r
set request_number = numbered.n
from numbered
where r.id = numbered.id;

alter table requests enable trigger requests_set_updated_at;

create sequence if not exists requests_request_number_seq owned by requests.request_number;

select setval(
  'requests_request_number_seq',
  coalesce((select max(request_number) from requests), 0) + 1,
  false
);

alter table requests alter column request_number set default nextval('requests_request_number_seq');
alter table requests alter column request_number set not null;

create unique index if not exists requests_request_number_key on requests (request_number);

notify pgrst, 'reload schema';
