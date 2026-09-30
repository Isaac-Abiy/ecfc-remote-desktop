-- ============================================================================
-- ECFC Remote Desktop — Supabase schema
-- ----------------------------------------------------------------------------
-- Run this in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- (Or: supabase db push / psql with your connection string.)
--
-- Tables:
--   rd_users      - account logins (email + bcrypt hash), optional TOTP 2FA
--   rd_computers  - registered office PCs, per-computer pairing secret
--   rd_sessions   - access log: every remote session, start + end times
--
-- Row Level Security is ENABLED on all three tables with NO public policies,
-- so anon/authenticated keys can read/write nothing. The signaling server uses
-- the service-role key, which bypasses RLS. This keeps the Supabase security
-- advisor happy while the server does its own checks.
-- ============================================================================

create table if not exists rd_users (
  id           uuid        primary key default gen_random_uuid(),
  email        text        unique not null,
  pass_hash    text        not null,
  totp_secret  text        null,
  totp_enabled boolean     not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists rd_computers (
  id             uuid        primary key default gen_random_uuid(),
  computer_id    text        unique not null,          -- 6-char code, e.g. 'A3F9K2'
  name           text,
  owner_id       uuid        references rd_users(id) on delete set null,
  pairing_secret text        not null,                 -- set by host on first register
  created_at     timestamptz not null default now()
);

create table if not exists rd_sessions (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        references rd_users(id) on delete cascade,
  computer_id text        not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz null
);

-- RLS on everything (no policies = locked down for anon/authenticated keys;
-- the server's service-role key bypasses RLS).
alter table rd_users     enable row level security;
alter table rd_computers enable row level security;
alter table rd_sessions  enable row level security;

-- Indexes for the lookups the server does on every auth/pair/status call.
create index if not exists rd_users_email_idx        on rd_users (email);
create index if not exists rd_computers_computer_id_idx on rd_computers (computer_id);
create index if not exists rd_sessions_user_id_idx   on rd_sessions (user_id);
