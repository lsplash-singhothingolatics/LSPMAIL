-- LSPMail schema. Safe to run on every deploy.

create table if not exists users (
  id          bigserial primary key,
  email       text unique not null,
  name        text,
  avatar_url  text,
  plan        text not null default 'starter',
  quota_bytes bigint not null default 42949672960,   -- 40 GB
  used_bytes  bigint not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists identities (
  id           bigserial primary key,
  user_id      bigint not null references users(id) on delete cascade,
  provider     text not null,          -- google | yahoo | github | otp
  provider_uid text not null,
  created_at   timestamptz not null default now(),
  unique (provider, provider_uid)
);

-- Every address the account can send or receive as.
create table if not exists addresses (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  address    text unique not null,
  label      text,
  is_primary boolean not null default false,
  verified   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists addresses_user_idx on addresses (user_id);

create table if not exists messages (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  address_id  bigint references addresses(id) on delete set null,
  direction   text not null,                     -- inbound | outbound
  folder      text not null default 'inbox',     -- inbox | sent | trash
  category    text not null default 'primary',   -- primary | social | promotions | updates
  from_addr   text not null,
  from_name   text,
  to_addrs    text[] not null default '{}',
  cc_addrs    text[] not null default '{}',
  subject     text,
  snippet     text,
  body_text   text,
  body_html   text,
  thread_key  text,
  starred     boolean not null default false,
  unread      boolean not null default true,
  size_bytes  bigint not null default 0,
  provider_id text,
  created_at  timestamptz not null default now()
);
create index if not exists messages_list_idx   on messages (user_id, folder, created_at desc);
create index if not exists messages_thread_idx on messages (user_id, thread_key);
create index if not exists messages_star_idx   on messages (user_id) where starred;

create table if not exists attachments (
  id           bigserial primary key,
  message_id   bigint not null references messages(id) on delete cascade,
  user_id      bigint not null references users(id) on delete cascade,
  filename     text not null,
  content_type text,
  size_bytes   bigint not null default 0,
  data         bytea,
  created_at   timestamptz not null default now()
);
create index if not exists attachments_msg_idx on attachments (message_id);

create table if not exists otp_codes (
  id         bigserial primary key,
  email      text not null,
  code_hash  text not null,
  attempts   int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists otp_email_idx on otp_codes (email, created_at desc);

create table if not exists orders (
  id           bigserial primary key,
  user_id      bigint not null references users(id) on delete cascade,
  razorpay_id  text unique not null,
  payment_id   text,
  kind         text not null,          -- plan | domain
  sku          text not null,
  amount_paise bigint not null,
  currency     text not null default 'INR',
  status       text not null default 'created',
  created_at   timestamptz not null default now()
);

create table if not exists domains (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  domain      text unique not null,
  resend_id   text,
  dns_records jsonb not null default '[]',
  status      text not null default 'pending',   -- pending | verifying | active
  created_at  timestamptz not null default now()
);
