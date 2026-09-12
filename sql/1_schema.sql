-- ============================================================
-- Домашка — schema for Supabase (Postgres + pgcrypto for uuids)
-- ============================================================
-- Run this once in Supabase: Project -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run top-to-bottom on a fresh project.

create extension if not exists pgcrypto;

-- ---------- Groups (e.g. "128", "121") ----------
create table groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- ---------- Invite codes ----------
-- One row per code. A group's "join code" has referrer_id = null.
-- A personal referral code has referrer_id = that user's profile id.
create table invite_codes (
  code        text primary key,
  group_id    uuid not null references groups(id) on delete cascade,
  referrer_id uuid, -- FK to profiles added below, once that table exists
  uses        int not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- Profiles (one per auth.users row) ----------
create table profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  full_name      text,
  group_id       uuid references groups(id),
  avatar_url     text,
  own_invite_code text unique,
  referred_by    uuid references profiles(id),
  is_owner       boolean not null default false,
  trial_until    timestamptz,
  paid_until     timestamptz,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- invite_codes.referrer_id references profiles, which is defined after it,
-- so add that foreign key now that both tables exist.
alter table invite_codes
  add constraint invite_codes_referrer_fk
  foreign key (referrer_id) references profiles(id) on delete set null;

-- ---------- Teachers (shared per group; literature list lives here) ----------
create table teachers (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references groups(id) on delete cascade,
  full_name   text not null,
  photo_url   text,
  literature  jsonb not null default '[]'::jsonb, -- [{"title":"...","author":"...","link":"..."}]
  created_at  timestamptz not null default now(),
  unique(group_id, full_name)
);

-- ---------- Schedule slots ----------
-- One row per (group, week, day, time-slot, subgroup-part).
-- part_index 0 = main/only lesson, 1 = the second subgroup when a slot is split.
create table schedule_slots (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references groups(id) on delete cascade,
  week_number  smallint not null check (week_number in (1,2)),
  day_index    smallint not null check (day_index between 0 and 5), -- 0=Mon..5=Sat
  slot_index   smallint not null check (slot_index between 0 and 7),
  part_index   smallint not null default 0 check (part_index in (0,1)),
  lesson_date  date,
  subject      text,
  teacher_id   uuid references teachers(id),
  room         text,
  groups_label text,
  updated_at   timestamptz not null default now(),
  unique (group_id, week_number, day_index, slot_index, part_index)
);

-- ---------- Homework attached to a schedule slot ----------
create table homework (
  id                uuid primary key default gen_random_uuid(),
  schedule_slot_id  uuid not null references schedule_slots(id) on delete cascade,
  description       text,
  due_date          date,
  created_by        uuid references profiles(id),
  updated_at        timestamptz not null default now(),
  unique(schedule_slot_id)
);

-- ---------- Bookable topics inside a homework item ----------
create table homework_topics (
  id           uuid primary key default gen_random_uuid(),
  homework_id  uuid not null references homework(id) on delete cascade,
  title        text not null,
  booked_by    uuid references profiles(id),
  created_at   timestamptz not null default now()
);

-- ---------- Per-student "done" marks (this is what turns a cell green) ----------
create table homework_done (
  homework_id  uuid not null references homework(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  done_at      timestamptz not null default now(),
  primary key (homework_id, user_id)
);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table groups            enable row level security;
alter table invite_codes      enable row level security;
alter table profiles          enable row level security;
alter table teachers          enable row level security;
alter table schedule_slots    enable row level security;
alter table homework          enable row level security;
alter table homework_topics   enable row level security;
alter table homework_done     enable row level security;

-- Helper: the caller's own group id, looked up once per statement.
-- SECURITY DEFINER is required here: these functions read profiles to
-- resolve the caller's own group/owner flag, and profiles itself has an
-- RLS policy that calls these same functions. Without SECURITY DEFINER
-- that becomes infinite recursion (policy -> function -> profiles query
-- -> policy -> ...). Running as the function owner (not the caller)
-- breaks that loop.
create or replace function my_group_id() returns uuid
language sql stable security definer set search_path = public as $$
  select group_id from profiles where id = auth.uid()
$$;

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from profiles where id = auth.uid()), false)
$$;

-- groups: anyone signed in can read (needed to show group name);
-- only the owner can create new groups (from the app, once they're set up).
create policy groups_read on groups for select using (true);
create policy groups_owner_write on groups for all
  using (is_owner()) with check (is_owner());

-- invite_codes: readable only to look up during signup (via a security-definer
-- function, not directly) — deny direct table access from the client.
create policy invite_codes_owner_all on invite_codes for all
  using (is_owner()) with check (is_owner());

-- profiles: everyone in the same group can see each other's basic info
-- (needed for "who booked this topic"); a user can only edit their own row;
-- the owner can see and edit everyone.
create policy profiles_read_group on profiles for select
  using (group_id = my_group_id() or is_owner());
create policy profiles_update_self on profiles for update
  using (id = auth.uid() or is_owner());
create policy profiles_insert_self on profiles for insert
  with check (id = auth.uid());

-- The self-update policy above only checks WHICH ROW is being touched, not
-- WHICH COLUMNS change - so on its own it would let a user UPDATE their own
-- row and quietly flip is_owner/group_id/trial_until/paid_until. Lock those
-- fields down at the row level with a trigger; only the owner can change them.
create or replace function protect_profile_fields() returns trigger
language plpgsql set search_path = public as $$
declare
  bypass boolean;
begin
  select rolbypassrls into bypass from pg_roles where rolname = current_user;
  if not coalesce(bypass, false) and not is_owner() then
    new.is_owner        := old.is_owner;
    new.group_id         := old.group_id;
    new.trial_until       := old.trial_until;
    new.paid_until        := old.paid_until;
    new.own_invite_code   := old.own_invite_code;
    new.referred_by       := old.referred_by;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_fields on profiles;
create trigger profiles_protect_fields
before update on profiles
for each row execute function protect_profile_fields();

-- teachers: readable by everyone in the group; writable only by owner
-- (photo/literature uploads go through the owner-only screen).
create policy teachers_read on teachers for select
  using (group_id = my_group_id() or is_owner());
create policy teachers_owner_write on teachers for all
  using (is_owner()) with check (is_owner());

-- schedule_slots: readable by the group; writes only via the service-role
-- key (the scraper) or the owner — never directly from a student's session.
create policy schedule_read on schedule_slots for select
  using (group_id = my_group_id() or is_owner());
create policy schedule_owner_write on schedule_slots for all
  using (is_owner()) with check (is_owner());

-- homework: readable by the group; any signed-in group member can add/edit
-- the description and due date (this mirrors how the old app worked).
create policy homework_read on homework for select
  using (
    exists (select 1 from schedule_slots s
            where s.id = homework.schedule_slot_id
              and (s.group_id = my_group_id() or is_owner()))
  );
create policy homework_write on homework for all
  using (
    exists (select 1 from schedule_slots s
            where s.id = homework.schedule_slot_id
              and (s.group_id = my_group_id() or is_owner()))
  )
  with check (
    exists (select 1 from schedule_slots s
            where s.id = homework.schedule_slot_id
              and (s.group_id = my_group_id() or is_owner()))
  );

-- homework_topics: readable by the group; anyone can propose a topic;
-- only the person who booked it (or nobody yet) can change the booking.
create policy topics_read on homework_topics for select
  using (
    exists (select 1 from homework h join schedule_slots s on s.id = h.schedule_slot_id
            where h.id = homework_topics.homework_id
              and (s.group_id = my_group_id() or is_owner()))
  );
create policy topics_insert on homework_topics for insert
  with check (
    exists (select 1 from homework h join schedule_slots s on s.id = h.schedule_slot_id
            where h.id = homework_topics.homework_id
              and (s.group_id = my_group_id() or is_owner()))
  );
create policy topics_update on homework_topics for update
  using (booked_by is null or booked_by = auth.uid() or is_owner());

-- homework_done: a student can only see and change their own done-marks;
-- the owner can see everyone's (needed for the usage dashboard).
create policy done_self on homework_done for select
  using (user_id = auth.uid() or is_owner());
create policy done_write on homework_done for insert
  with check (user_id = auth.uid());
create policy done_delete on homework_done for delete
  using (user_id = auth.uid());

-- ============================================================
-- Signup helper: redeem an invite code without exposing the
-- invite_codes table (and its referrer links) to every client.
-- ============================================================
create or replace function redeem_invite(p_code text, p_full_name text)
returns uuid
language plpgsql security definer as $$
declare
  v_group_id uuid;
  v_referrer uuid;
  v_own_code text;
begin
  select group_id, referrer_id into v_group_id, v_referrer
  from invite_codes where code = p_code;

  if v_group_id is null then
    raise exception 'invalid_code';
  end if;

  update invite_codes set uses = uses + 1 where code = p_code;

  v_own_code := substr(md5(auth.uid()::text || clock_timestamp()::text), 1, 8);

  insert into profiles (id, full_name, group_id, referred_by, own_invite_code, trial_until)
  values (auth.uid(), p_full_name, v_group_id, v_referrer, v_own_code, now() + interval '30 days')
  on conflict (id) do update
    set full_name = excluded.full_name,
        group_id = excluded.group_id;

  return v_group_id;
end;
$$;
