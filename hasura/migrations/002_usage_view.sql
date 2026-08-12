create or replace view organization_monthly_usage as
select
  o.id as organization_id,
  o.name,
  o.quota_allowed,
  o.quota_used,
  greatest(o.quota_allowed - o.quota_used, 0) as quota_remaining
from organizations o;
