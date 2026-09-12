-- ============================================================
-- Migration 002: replace invite codes with roster-based signup
-- ============================================================
-- Run this in Supabase SQL Editor AFTER schema.sql. Safe to run once.

-- The invite-code system is no longer used - group + full name against
-- a real roster does the job of proving "this person actually exists",
-- and a plain link (?ref=<their id>) handles referral credit instead of
-- a typed personal code.
drop function if exists redeem_invite(text, text);
drop table if exists invite_codes cascade;
alter table profiles drop column if exists own_invite_code;

-- ---------- Roster: the real list of students per group ----------
-- Only the owner can see/manage this directly (it's real people's names).
-- Signup itself goes through join_by_roster() below, which checks against
-- this table without exposing the whole list to every visitor.
create table if not exists roster (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references groups(id) on delete cascade,
  full_name   text not null,
  claimed_by  uuid references profiles(id),
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique(group_id, full_name)
);
alter table roster enable row level security;

drop policy if exists roster_owner_all on roster;
create policy roster_owner_all on roster for all
  using (is_owner()) with check (is_owner());

-- ---------- Signup: group + full name, matched against the roster ----------
create or replace function join_by_roster(p_group_id uuid, p_full_name text, p_ref uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_roster_id uuid;
  v_referrer  uuid;
begin
  select id into v_roster_id
  from roster
  where group_id = p_group_id
    and lower(trim(full_name)) = lower(trim(p_full_name))
    and claimed_by is null
  limit 1;

  if v_roster_id is null then
    raise exception 'not_in_roster';
  end if;

  -- A referral link only counts if it points to a real profile in the
  -- same group; otherwise it's silently ignored rather than erroring.
  if p_ref is not null then
    select id into v_referrer from profiles where id = p_ref and group_id = p_group_id;
  end if;

  insert into profiles (id, full_name, group_id, referred_by, trial_until)
  values (auth.uid(), p_full_name, p_group_id, v_referrer, now() + interval '30 days')
  on conflict (id) do update
    set full_name = excluded.full_name, group_id = excluded.group_id;

  update roster set claimed_by = auth.uid(), claimed_at = now() where id = v_roster_id;

  return p_group_id;
end;
$$;
