create extension if not exists pgcrypto;

create table if not exists public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  status text not null default 'lobby',
  current_round_id uuid,
  last_started_by_player_id uuid,
  round_number integer not null default 0,
  base_duration_seconds integer not null default 45,
  conflict_duration_seconds integer not null default 25,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  name text not null,
  join_order integer not null,
  score integer not null default 0,
  player_token text not null unique,
  created_at timestamptz not null default now(),
  unique(room_id, name)
);

create table if not exists public.questions (
  id text primary key,
  case_study text,
  question text not null,
  correct_answer text not null,
  incorrect_answers text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  question_id text not null references public.questions(id),
  status text not null,
  started_at timestamptz not null,
  base_deadline timestamptz not null,
  conflict_deadline timestamptz,
  early_bonus_cutoff timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.round_assignments (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  option_text text not null,
  is_correct boolean not null,
  created_at timestamptz not null default now(),
  unique(round_id, player_id)
);

create table if not exists public.base_submissions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  confidence text not null,
  submitted_at timestamptz not null default now(),
  unique(round_id, player_id)
);

create table if not exists public.conflict_submissions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  action_choice text not null,
  submitted_at timestamptz not null default now(),
  unique(round_id, player_id)
);

create table if not exists public.score_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  points integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_players_room on public.players(room_id);
create index if not exists idx_rounds_room on public.rounds(room_id);
create index if not exists idx_assignments_round on public.round_assignments(round_id);
create index if not exists idx_base_submissions_round on public.base_submissions(round_id);
create index if not exists idx_conflict_submissions_round on public.conflict_submissions(round_id);

alter table public.game_rooms enable row level security;
alter table public.players enable row level security;
alter table public.questions enable row level security;
alter table public.rounds enable row level security;
alter table public.round_assignments enable row level security;
alter table public.base_submissions enable row level security;
alter table public.conflict_submissions enable row level security;
alter table public.score_events enable row level security;

drop policy if exists "deny_all_game_rooms" on public.game_rooms;
drop policy if exists "deny_all_players" on public.players;
drop policy if exists "deny_all_questions" on public.questions;
drop policy if exists "deny_all_rounds" on public.rounds;
drop policy if exists "deny_all_round_assignments" on public.round_assignments;
drop policy if exists "deny_all_base_submissions" on public.base_submissions;
drop policy if exists "deny_all_conflict_submissions" on public.conflict_submissions;
drop policy if exists "deny_all_score_events" on public.score_events;

create policy "deny_all_game_rooms" on public.game_rooms for all using (false) with check (false);
create policy "deny_all_players" on public.players for all using (false) with check (false);
create policy "deny_all_questions" on public.questions for all using (false) with check (false);
create policy "deny_all_rounds" on public.rounds for all using (false) with check (false);
create policy "deny_all_round_assignments" on public.round_assignments for all using (false) with check (false);
create policy "deny_all_base_submissions" on public.base_submissions for all using (false) with check (false);
create policy "deny_all_conflict_submissions" on public.conflict_submissions for all using (false) with check (false);
create policy "deny_all_score_events" on public.score_events for all using (false) with check (false);
