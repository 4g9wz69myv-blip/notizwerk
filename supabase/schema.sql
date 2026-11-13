-- Notizwerk: Datenbank für die Synchronisation.
-- Einmal komplett im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden.

-- 1) Notizen: eine Zeile pro Seite plus eine Zeile "struct" für Notizbücher/Abschnitte
create table if not exists public.nw_items (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  kind       text        not null check (kind in ('page', 'struct')),
  status     text        not null default 'live' check (status in ('live', 'trash', 'gone')),
  body       jsonb,
  rev        bigint      not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index if not exists nw_items_user_updated on public.nw_items (user_id, updated_at);

alter table public.nw_items enable row level security;

drop policy if exists "nw_items lesen" on public.nw_items;
drop policy if exists "nw_items anlegen" on public.nw_items;
drop policy if exists "nw_items ändern" on public.nw_items;
create policy "nw_items lesen"   on public.nw_items for select to authenticated using (user_id = (select auth.uid()));
create policy "nw_items anlegen" on public.nw_items for insert to authenticated with check (user_id = (select auth.uid()));
create policy "nw_items ändern"  on public.nw_items for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.nw_items from anon;
grant select, insert, update on public.nw_items to authenticated;

-- 2) Hochladen: schreibt nur, wenn die Änderung neuer ist als die gespeicherte (rev)
create or replace function public.nw_push(items jsonb)
returns table (id text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'nicht angemeldet';
  end if;
  return query
  insert into public.nw_items as t (user_id, id, kind, status, body, rev, updated_at)
  select auth.uid(), i ->> 'id', i ->> 'kind', i ->> 'status', i -> 'body', (i ->> 'rev')::bigint, clock_timestamp()
  from jsonb_array_elements(items) as i
  on conflict (user_id, id) do update
    set kind = excluded.kind, status = excluded.status, body = excluded.body,
        rev = excluded.rev, updated_at = clock_timestamp()
    where t.rev < excluded.rev
  returning t.id;
end;
$$;
revoke all on function public.nw_push(jsonb) from public, anon;
grant execute on function public.nw_push(jsonb) to authenticated;

-- 3) Keep-alive: eine tägliche Anfrage hält das kostenlose Projekt aktiv
create table if not exists public.nw_heartbeat (
  id int primary key default 1 check (id = 1),
  at timestamptz not null default now()
);
alter table public.nw_heartbeat enable row level security;
revoke all on public.nw_heartbeat from anon, authenticated;

create or replace function public.nw_keepalive()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  insert into public.nw_heartbeat (id, at) values (1, now())
  on conflict (id) do update set at = now()
  returning at;
$$;
revoke all on function public.nw_keepalive() from public;
grant execute on function public.nw_keepalive() to anon, authenticated;
