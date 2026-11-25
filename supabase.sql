-- Portfolia: progreso de cada cuenta en la nube.
-- Pégalo en Supabase → SQL Editor → New query → Run.
-- Cada fila es de una sola persona y RLS impide leer o escribir la de otra.

create table if not exists public.progreso (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.progreso enable row level security;

-- solo las personas con sesión iniciada pueden tocar la tabla (y RLS las limita a su propia fila)
grant select, insert, update on public.progreso to authenticated;

create policy "leer mi progreso"       on public.progreso for select using (auth.uid() = user_id);
create policy "crear mi progreso"      on public.progreso for insert with check (auth.uid() = user_id);
create policy "actualizar mi progreso" on public.progreso for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
