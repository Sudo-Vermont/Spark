-- Spark accounts schema — paste this whole file into the Supabase SQL Editor and click Run.
-- Everything is locked down with Row Level Security: the browser's public key can only
-- do what these policies allow, no matter how the client code is modified.

-- ── Profiles ──────────────────────────────────────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null
             check (char_length(username) between 3 and 24 and username ~ '^[a-zA-Z0-9_]+$'),
  avatar     text not null default '😀' check (char_length(avatar) <= 8),
  bio        text not null default '' check (char_length(bio) <= 80),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "signed-in users can view profiles"
  on public.profiles for select to authenticated using (true);

create policy "users create only their own profile"
  on public.profiles for insert to authenticated with check (auth.uid() = id);

create policy "users update only their own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ── Friendships ───────────────────────────────────────────────────────────
create table public.friendships (
  id         bigint generated always as identity primary key,
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);

-- One row per pair regardless of direction
create unique index friendships_pair_uniq
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

alter table public.friendships enable row level security;

create policy "users see their own friendships"
  on public.friendships for select to authenticated
  using (auth.uid() in (requester, addressee));

create policy "users send requests as themselves"
  on public.friendships for insert to authenticated
  with check (auth.uid() = requester and status = 'pending');

create policy "only the addressee can accept"
  on public.friendships for update to authenticated
  using (auth.uid() = addressee) with check (status = 'accepted');

create policy "either side can remove a friendship"
  on public.friendships for delete to authenticated
  using (auth.uid() in (requester, addressee));

-- ── Direct messages ───────────────────────────────────────────────────────
create table public.messages (
  id         bigint generated always as identity primary key,
  sender     uuid not null references public.profiles(id) on delete cascade,
  recipient  uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index messages_pair_idx on public.messages
  (least(sender, recipient), greatest(sender, recipient), created_at desc);

alter table public.messages enable row level security;

create policy "users read only their own conversations"
  on public.messages for select to authenticated
  using (auth.uid() in (sender, recipient));

create policy "users message only their friends, as themselves"
  on public.messages for insert to authenticated
  with check (
    auth.uid() = sender
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester = sender and f.addressee = recipient)
          or (f.requester = recipient and f.addressee = sender))
    )
  );

-- ── Realtime for live chat ────────────────────────────────────────────────
alter publication supabase_realtime add table public.messages;
