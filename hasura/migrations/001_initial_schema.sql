-- Initial schema for AI Agent Workflow Builder.
-- Hasura tracking, relationships and permissions are added after schema creation.

create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  quota_allowed integer not null default 100,
  quota_used integer not null default 0,
  quota_period_start timestamptz not null default date_trunc('month', now()),
  created_at timestamptz not null default now()
);

create table if not exists org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  position integer not null,
  type text not null check (
    type in (
      'llm_call',
      'http_request',
      'db_write',
      'notify',
      'conditional_branch',
      'approval_gate'
    )
  ),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workflow_id, position)
);

create table if not exists workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  type text not null check (
    type in ('manual', 'webhook', 'scheduled', 'database_event')
  ),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'running', 'paused', 'completed', 'failed')
  ),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists step_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  workflow_step_id uuid not null references workflow_steps(id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'running', 'paused', 'completed', 'failed')
  ),
  input jsonb,
  output jsonb,
  error text,
  attempt_count integer not null default 0,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_org_members_user on org_members(user_id);
create index if not exists idx_workflows_org on workflows(org_id);
create index if not exists idx_workflow_steps_workflow on workflow_steps(workflow_id);
create index if not exists idx_workflow_triggers_workflow on workflow_triggers(workflow_id);
create index if not exists idx_workflow_runs_workflow on workflow_runs(workflow_id);
create index if not exists idx_step_runs_run on step_runs(workflow_run_id);
