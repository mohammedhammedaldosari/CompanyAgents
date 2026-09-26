-- OAuth 2.1 authorization-code flows in progress (state → connector). Single-use, short-lived.
create table oauth_states (
  state      text primary key,
  tool       text not null,
  created_at timestamptz not null default now()
);
