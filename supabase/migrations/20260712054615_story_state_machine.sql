-- F2-02 · Story state machine — legal transitions DECLARED IN DATA, enforced at a
-- SINGLE point: a trigger on public.stories. This is the deterministic kernel
-- (golden rule 2). It is enforced in the DB, not a Go helper, precisely because
-- v1's "centralized" state machine was bypassed by 16 raw status='…' writes
-- (L-CQ-2). A trigger cannot be sidestepped — every writer (authenticated or
-- service_role) passes through it.

-- The legal transition graph, as data. Adding/removing an edge is a row, not code.
create table public.story_status_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

insert into public.story_status_transitions (from_status, to_status) values
  ('backlog','ready'),   ('backlog','blocked'),
  ('ready','running'),   ('ready','blocked'),
  ('running','review'),  ('running','failed'), ('running','blocked'), ('running','ready'),
  ('review','done'),     ('review','running'), ('review','failed'),
  ('failed','ready'),    ('failed','running'),
  ('blocked','ready'),   ('blocked','backlog');

-- Reference data (not tenant-scoped): readable by all, writable by nobody via the
-- API. RLS with a permissive read policy keeps it out of the "table without RLS"
-- lint while staying globally visible.
alter table public.story_status_transitions enable row level security;
create policy story_status_transitions_read on public.story_status_transitions
  for select to anon, authenticated using (true);
grant select on public.story_status_transitions to anon, authenticated;

-- The single mutation point. A story is born 'backlog'; every later status change
-- must be a declared edge, else the write is rejected. updated_at is stamped here
-- so callers can never forget it.
create or replace function public.enforce_story_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'backlog' then
      raise exception 'illegal story birth status %, must be backlog', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE: a no-op status is always fine; a change must be a declared edge.
  if new.status is distinct from old.status then
    if not exists (
      select 1 from public.story_status_transitions
      where from_status = old.status and to_status = new.status
    ) then
      raise exception 'illegal story transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    new.updated_at = now();
  end if;

  return new;
end;
$$;

create trigger enforce_story_transition
  before insert or update on public.stories
  for each row execute function public.enforce_story_transition();
