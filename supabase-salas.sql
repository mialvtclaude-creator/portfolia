-- Portfolia: usuarios, amigos y salas de competencia.
-- Pégalo completo en Supabase → SQL Editor → New query → Run. Se puede volver a correr sin romper nada.

create extension if not exists pgcrypto with schema extensions;

-- 1. Nombre de usuario público de cada cuenta (para buscar amigos y salir en los rankings)
create table if not exists public.perfiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  usuario text unique not null check (usuario ~ '^[a-z0-9_]{3,20}$'),
  creado  timestamptz not null default now()
);
alter table public.perfiles enable row level security;
drop policy if exists "ver perfiles" on public.perfiles;
drop policy if exists "crear mi perfil" on public.perfiles;
drop policy if exists "cambiar mi perfil" on public.perfiles;
create policy "ver perfiles"      on public.perfiles for select to authenticated using (true);
create policy "crear mi perfil"   on public.perfiles for insert to authenticated with check (auth.uid() = user_id);
create policy "cambiar mi perfil" on public.perfiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update on public.perfiles to authenticated;

-- 2. Amistades: una solicitud pendiente que la otra persona acepta
create table if not exists public.amistades (
  de     uuid not null references auth.users (id) on delete cascade,
  para   uuid not null references auth.users (id) on delete cascade,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aceptada')),
  creado timestamptz not null default now(),
  primary key (de, para),
  check (de <> para)
);
alter table public.amistades enable row level security;
drop policy if exists "ver mis amistades" on public.amistades;
drop policy if exists "enviar solicitud" on public.amistades;
drop policy if exists "aceptar solicitud" on public.amistades;
drop policy if exists "quitar amistad" on public.amistades;
create policy "ver mis amistades" on public.amistades for select to authenticated using (auth.uid() in (de, para));
create policy "enviar solicitud"  on public.amistades for insert to authenticated with check (auth.uid() = de and estado = 'pendiente');
create policy "aceptar solicitud" on public.amistades for update to authenticated using (auth.uid() = para) with check (auth.uid() = para and estado = 'aceptada');
create policy "quitar amistad"    on public.amistades for delete to authenticated using (auth.uid() in (de, para));
grant select, insert, update, delete on public.amistades to authenticated;

-- 3. Salas con contraseña (guardada cifrada) y sus miembros
create table if not exists public.salas (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null check (char_length(nombre) between 3 and 40),
  codigo     text unique not null,
  clave_hash text not null,
  creador    uuid not null references auth.users (id) on delete cascade,
  creado     timestamptz not null default now()
);
create table if not exists public.sala_miembros (
  sala        uuid not null references public.salas (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  inicio      numeric,              -- patrimonio en la Bolsa real al empezar a competir
  actual      numeric,              -- patrimonio más reciente
  actualizado timestamptz not null default now(),
  unido       timestamptz not null default now(),
  primary key (sala, user_id)
);
alter table public.salas enable row level security;
alter table public.sala_miembros enable row level security;

-- ¿la persona con sesión está en esta sala? (función aparte para que la política no se llame a sí misma)
create or replace function public.es_miembro(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sala_miembros where sala = s and user_id = auth.uid())
$$;

drop policy if exists "ver mis salas" on public.salas;
drop policy if exists "ver miembros de mis salas" on public.sala_miembros;
drop policy if exists "actualizar mi puntaje" on public.sala_miembros;
drop policy if exists "salir de una sala" on public.sala_miembros;
create policy "ver mis salas"             on public.salas         for select to authenticated using (public.es_miembro(id));
create policy "ver miembros de mis salas" on public.sala_miembros for select to authenticated using (public.es_miembro(sala));
create policy "actualizar mi puntaje"     on public.sala_miembros for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "salir de una sala"         on public.sala_miembros for delete to authenticated using (auth.uid() = user_id);

-- nadie lee el hash de la contraseña; los miembros solo ven nombre y código
revoke all on public.salas from anon, authenticated;
grant select (id, nombre, codigo, creador, creado) on public.salas to authenticated;
revoke all on public.sala_miembros from anon, authenticated;
grant select, delete on public.sala_miembros to authenticated;
grant update (inicio, actual) on public.sala_miembros to authenticated;

-- el punto de partida no se puede cambiar una vez fijado (evita reiniciarlo para inflar el rendimiento)
create or replace function public.fijar_inicio() returns trigger language plpgsql as $$
begin
  if old.inicio is not null then new.inicio := old.inicio; end if;
  new.actualizado := now();
  return new;
end $$;
drop trigger if exists fijar_inicio on public.sala_miembros;
create trigger fijar_inicio before update on public.sala_miembros for each row execute function public.fijar_inicio();

-- crear una sala: genera el código y guarda la contraseña cifrada
create or replace function public.crear_sala(p_nombre text, p_clave text, p_inicio numeric)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_codigo text;
begin
  if auth.uid() is null then raise exception 'Inicia sesión para crear una sala'; end if;
  if char_length(trim(coalesce(p_nombre, ''))) < 3 then raise exception 'El nombre de la sala necesita al menos 3 letras'; end if;
  if char_length(coalesce(p_clave, '')) < 4 then raise exception 'La contraseña de la sala necesita al menos 4 caracteres'; end if;
  loop
    v_codigo := upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
    exit when not exists (select 1 from public.salas where codigo = v_codigo);
  end loop;
  insert into public.salas (nombre, codigo, clave_hash, creador)
  values (trim(p_nombre), v_codigo, crypt(p_clave, gen_salt('bf')), auth.uid())
  returning id into v_id;
  insert into public.sala_miembros (sala, user_id, inicio, actual) values (v_id, auth.uid(), p_inicio, p_inicio);
  return json_build_object('id', v_id, 'codigo', v_codigo);
end $$;

-- unirse a una sala: la contraseña se compara aquí, en el servidor
create or replace function public.unirse_sala(p_codigo text, p_clave text, p_inicio numeric)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v public.salas%rowtype;
begin
  if auth.uid() is null then raise exception 'Inicia sesión para unirte a una sala'; end if;
  select * into v from public.salas where codigo = upper(trim(p_codigo));
  if not found or v.clave_hash <> crypt(coalesce(p_clave, ''), v.clave_hash) then
    raise exception 'Código o contraseña incorrectos';
  end if;
  insert into public.sala_miembros (sala, user_id, inicio, actual)
  values (v.id, auth.uid(), p_inicio, p_inicio)
  on conflict (sala, user_id) do nothing;
  return json_build_object('id', v.id, 'nombre', v.nombre, 'codigo', v.codigo);
end $$;

revoke all on function public.crear_sala(text, text, numeric) from public, anon;
revoke all on function public.unirse_sala(text, text, numeric) from public, anon;
revoke all on function public.es_miembro(uuid) from public, anon;
grant execute on function public.crear_sala(text, text, numeric) to authenticated;
grant execute on function public.unirse_sala(text, text, numeric) to authenticated;
grant execute on function public.es_miembro(uuid) to authenticated;
