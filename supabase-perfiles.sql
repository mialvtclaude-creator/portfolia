-- Portfolia: perfiles públicos, foto de perfil y ranking global.
-- Requiere haber corrido antes supabase-salas.sql (usa la tabla perfiles).
-- Pégalo completo en Supabase → SQL Editor → New query → Run. Se puede volver a correr sin romper nada.

-- 1. Los nombres de usuario se pueden ver sin iniciar sesión (para el ranking público y el buscador)
drop policy if exists "ver perfiles" on public.perfiles;
create policy "ver perfiles" on public.perfiles for select to anon, authenticated using (true);
grant select on public.perfiles to anon;

-- 2. Estadísticas públicas de cada jugador: nivel, insignias, retorno y portafolio
create table if not exists public.estadisticas (
  user_id     uuid primary key references public.perfiles (user_id) on delete cascade,
  avatar_url  text check (avatar_url is null or avatar_url like 'https://wiozdymslywmqaoootku.supabase.co/storage/v1/object/public/avatares/%'),
  nivel       int  not null default 1 check (nivel between 1 and 99),
  rango       text check (rango is null or char_length(rango) <= 40),
  xp          int  not null default 0 check (xp >= 0),
  insignias   text[] not null default '{}',
  estrellas   int  not null default 0 check (estrellas >= 0),
  operaciones int  not null default 0 check (operaciones >= 0),
  inicio      numeric,                -- patrimonio al empezar en la Bolsa real (queda fijo)
  patrimonio  numeric,                -- patrimonio más reciente en la Bolsa real
  efectivo    numeric,
  retorno     numeric generated always as (case when inicio > 0 and patrimonio is not null then round((patrimonio / inicio - 1) * 100, 2) end) stored,
  cartera     jsonb not null default '[]'::jsonb check (jsonb_typeof(cartera) = 'array'),
  publico     boolean not null default true,
  actualizado timestamptz not null default now()
);
create index if not exists estadisticas_retorno on public.estadisticas (retorno desc) where publico and retorno is not null;

alter table public.estadisticas enable row level security;
drop policy if exists "ver perfiles públicos" on public.estadisticas;
drop policy if exists "crear mis estadísticas" on public.estadisticas;
drop policy if exists "actualizar mis estadísticas" on public.estadisticas;
create policy "ver perfiles públicos"       on public.estadisticas for select to anon, authenticated using (publico or auth.uid() = user_id);
create policy "crear mis estadísticas"      on public.estadisticas for insert to authenticated with check (auth.uid() = user_id);
create policy "actualizar mis estadísticas" on public.estadisticas for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.estadisticas from anon, authenticated;
grant select on public.estadisticas to anon, authenticated;
grant insert (user_id, avatar_url, nivel, rango, xp, insignias, estrellas, operaciones, inicio, patrimonio, efectivo, cartera, publico) on public.estadisticas to authenticated;
grant update (avatar_url, nivel, rango, xp, insignias, estrellas, operaciones, inicio, patrimonio, efectivo, cartera, publico) on public.estadisticas to authenticated;

-- el punto de partida del retorno no se puede cambiar una vez fijado
create or replace function public.fijar_inicio_stats() returns trigger language plpgsql as $$
begin
  if old.inicio is not null then new.inicio := old.inicio; end if;
  new.actualizado := now();
  return new;
end $$;
drop trigger if exists fijar_inicio_stats on public.estadisticas;
create trigger fijar_inicio_stats before update on public.estadisticas for each row execute function public.fijar_inicio_stats();

-- 3. Fotos de perfil: bucket público de lectura; cada persona solo escribe en su propia carpeta
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatares', 'avatares', true, 524288, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "ver mi carpeta de avatar" on storage.objects;
drop policy if exists "subir mi avatar" on storage.objects;
drop policy if exists "cambiar mi avatar" on storage.objects;
drop policy if exists "borrar mi avatar" on storage.objects;
create policy "ver mi carpeta de avatar" on storage.objects for select to authenticated
  using (bucket_id = 'avatares' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "subir mi avatar" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatares' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cambiar mi avatar" on storage.objects for update to authenticated
  using (bucket_id = 'avatares' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatares' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "borrar mi avatar" on storage.objects for delete to authenticated
  using (bucket_id = 'avatares' and (storage.foldername(name))[1] = auth.uid()::text);
