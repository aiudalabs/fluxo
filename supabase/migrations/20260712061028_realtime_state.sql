-- F3-04 · Project state changes to the UI over Realtime — no polling, no serial
-- conductor (kills L-ARCH-4). Adding stories/runs to the supabase_realtime
-- publication makes the Maestro's status transitions stream to the console the
-- instant they happen. Row-level authorization still applies: a subscriber only
-- receives rows its tenant JWT can SELECT under the RLS policies (F2-01), so the
-- realtime stream is tenant-isolated exactly like the reads.
--
-- UPDATEs need REPLICA IDENTITY FULL so the old row (and thus a status change) is
-- carried in the change payload — a story board reacts to status transitions, and
-- a transition is an UPDATE.

alter table public.stories replica identity full;
alter table public.runs    replica identity full;

alter publication supabase_realtime add table public.stories;
alter publication supabase_realtime add table public.runs;
