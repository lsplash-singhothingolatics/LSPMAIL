-- oauth_codes, typed to match whatever users.id already is (uuid or bigint).
-- Hard-coding the type is what caused:
--   foreign key constraint "oauth_codes_user_id_fkey" cannot be implemented
do $$
declare
  id_type text;
begin
  if to_regclass('public.oauth_codes') is not null then
    return;                                   -- already built, leave it alone
  end if;

  select format_type(a.atttypid, a.atttypmod)
    into id_type
    from pg_attribute a
   where a.attrelid = 'public.users'::regclass
     and a.attname  = 'id'
     and a.attnum   > 0
     and not a.attisdropped;

  if id_type is null then
    raise exception 'users.id not found - create the users table first';
  end if;

  execute format($f$
    create table public.oauth_codes (
      code_hash      text primary key,
      client_id      text not null,
      user_id        %s not null references public.users(id) on delete cascade,
      redirect_uri   text not null,
      scope          text not null default 'openid email profile',
      code_challenge text,
      used           boolean not null default false,
      expires_at     timestamptz not null,
      created_at     timestamptz not null default now()
    )$f$, id_type);
end $$;

create index if not exists oauth_codes_expiry_idx on public.oauth_codes(expires_at);
