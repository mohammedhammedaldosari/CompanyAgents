-- شركة الوكلاء — المخطط الأولي (spec §20: tasks · routines · products · product_stages · alerts · policies · kpi_daily ·
-- metrics · chats · briefs · notes · events · connectors · tool_calls · secrets). Policies live inside the versioned config.
-- Money: bigint halalas. Times: timestamptz.

create table owner_account (
  id            int primary key default 1 check (id = 1),
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

create table sessions (
  id           text primary key,            -- sha256(token), the token itself is never stored
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ip           text not null default '',
  user_agent   text not null default ''
);
create index sessions_expires_idx on sessions (expires_at);

create table api_tokens (
  id           text primary key,
  name         text not null,
  token_hash   text not null unique,
  scope        text not null check (scope in ('ingest')),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create table company_state (
  id             int primary key default 1 check (id = 1),
  running        boolean not null default true,
  notes_count    int not null default 0,
  cash           bigint not null default 0,
  last_brief_day int not null default 0,
  last_day       int not null default 0,
  usage_warned   int not null default 0,
  usage_month    text not null default '',
  greeted        jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

create table config_versions (
  version      int primary key,
  config       jsonb not null,
  published_at timestamptz not null default now(),
  note         text not null default '',
  changes      jsonb not null default '[]'::jsonb
);

create table metrics_base (
  dept text primary key,
  v0   double precision not null default 0,
  v1   double precision not null default 0
);

create table kpi_daily (
  day      date primary key,
  sales    bigint not null default 0,
  profit   bigint not null default 0,
  ad_spend bigint not null default 0,
  orders   int not null default 0
);

create table products (
  id          text primary key,
  name        text not null,
  sku         text not null unique,
  asin        text,
  stage       text not null check (stage in ('research','sourcing','shipping','live','paused')),
  stage_since timestamptz not null,
  cost        bigint not null default 0,
  price       bigint not null default 0,
  stock       int not null default 0,
  sales7d     int not null default 0,
  today_sold  int not null default 0,
  note        text not null default '',
  flags       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table product_stages (
  id         bigserial primary key,
  product_id text not null references products(id) on delete cascade,
  stage      text not null,
  at         timestamptz not null
);
create index product_stages_product_idx on product_stages (product_id, at);

create table routines (
  id         text primary key,
  title      text not null,
  dept       text not null,
  agent      text not null,
  freq       text not null check (freq in ('daily','workdays','weekly','monthly1')),
  dow        int check (dow between 0 and 6),
  time       text not null check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  action     text not null,
  paused     boolean not null default false,
  created_at timestamptz not null default now()
);

create table tasks (
  id              text primary key,
  title           text not null,
  dept            text not null,
  agent           text not null,
  status          text not null check (status in ('scheduled','progress','waiting','done','backlog','cancelled')),
  at              timestamptz,
  done_at         timestamptz,
  progress        real not null default 0,
  action          text not null,
  value           double precision,
  ok              boolean not null default true,
  force           boolean not null default false,
  routine_id      text,
  source          text,
  product_id      text references products(id) on delete set null,
  model           text not null default 'SONNET',
  team            boolean not null default false,
  via_exec        boolean not null default false,
  routing         jsonb,              -- pending CEO routing {mode, at}
  artifact        jsonb,
  result          jsonb,
  approval_reason text,
  pending_call    jsonb,              -- gated tool call kept verbatim until the owner decides
  owner_note      text,               -- "send back" note
  fix             boolean not null default false,
  cost            bigint,
  tokens          int,
  attempts        int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index tasks_status_idx on tasks (status);
create index tasks_at_idx on tasks (at);
create index tasks_agent_idx on tasks (agent) where status in ('scheduled','progress','waiting','backlog');
-- one planned run per routine slot: makes routine materialisation idempotent
create unique index tasks_routine_slot_idx on tasks (routine_id, at) where routine_id is not null;

create table task_runs (
  id          bigserial primary key,
  task_id     text not null references tasks(id) on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null check (status in ('running','done','waiting','failed','aborted')),
  model_id    text not null,
  messages    jsonb not null default '[]'::jsonb,   -- full transcript (append-only), used to resume after approval
  error       text
);
create index task_runs_task_idx on task_runs (task_id, id desc);

create table alerts (
  id         text primary key,
  level      text not null check (level in ('critical','warning','info')),
  dept       text not null,
  agent      text not null,
  title      text not null,
  detail     text not null default '',
  product_id text references products(id) on delete set null,
  at         timestamptz not null default now(),
  dismissed  boolean not null default false,
  task_id    text
);
create index alerts_at_idx on alerts (at desc);

create table briefs (
  id   text primary key,
  at   timestamptz not null,
  text text not null,
  read boolean not null default false
);

create table chats (
  id   bigserial primary key,
  dept text not null,
  me   boolean not null,
  text text not null,
  at   timestamptz not null default now()
);
create index chats_dept_idx on chats (dept, id);

create table notes (
  id         text primary key,
  slug       text not null unique,
  title      text not null,
  body       text not null default '',
  tags       text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table events (
  id    bigserial primary key,
  t     timestamptz not null default now(),
  dept  text not null,
  agent text not null,
  kind  text not null,
  text  text not null
);
create index events_t_idx on events (id desc);

create table connectors (
  tool       text primary key,
  state      text not null default 'needs_auth',
  scopes     text not null default 'read' check (scopes in ('read','write')),
  last_sync  timestamptz,
  last4      text not null default '',
  url        text not null default '',
  auth       text not null default 'key',
  latency    int,
  last_error text not null default '',
  log        jsonb not null default '[]'::jsonb
);

create table secrets (
  id         text primary key,
  iv         text not null,
  tag        text not null,
  data       text not null,
  updated_at timestamptz not null default now()
);

create table tool_calls (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  task_id     text,
  agent       text not null,
  dept        text not null,
  tool        text not null,
  connector   text,
  action      text,
  value       double precision,
  input       jsonb not null,
  output      jsonb,
  status      text not null check (status in ('executed','pending_approval','approved','rejected','error','denied','skipped')),
  approved_by text,
  approved_at timestamptz,
  duration_ms int,
  error       text
);
create index tool_calls_task_idx on tool_calls (task_id);
create index tool_calls_at_idx on tool_calls (at desc);

create table audit_log (
  id     text primary key,
  at     timestamptz not null default now(),
  actor  text not null,
  area   text not null,
  action text not null,
  target text not null default '',
  detail jsonb
);
create index audit_at_idx on audit_log (at desc);

create table usage_records (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  month         text not null,
  day           int not null,
  kind          text not null check (kind in ('task','chat')),
  task_id       text,
  agent         text not null,
  dept          text not null,
  model         text not null,
  model_id      text not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cache_read    int not null default 0,
  cache_write   int not null default 0,
  cost          bigint not null default 0
);
create index usage_month_idx on usage_records (month);
