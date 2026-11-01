-- v2 content agent: monthly plan, scheduled publishing, metrics. Idempotent (already applied live).
create table if not exists public.sv_plan (
  month text primary key,
  status text not null default 'pending',
  summary text,
  admin_message_id bigint,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table if not exists public.sv_plan_items (
  id bigint generated always as identity primary key,
  month text not null references public.sv_plan(month),
  post_date date not null,
  slot_time text,
  post_type text not null,
  pillar text,
  theme text,
  core_message text,
  hook_idea text,
  cta text,
  status text not null default 'planned',
  post_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.sv_state (
  chat_id text primary key,
  awaiting text,
  payload jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sv_posts add column if not exists post_type text not null default 'text_image';
alter table public.sv_posts add column if not exists plan_item_id bigint;
alter table public.sv_posts add column if not exists scheduled_at timestamptz;
alter table public.sv_posts add column if not exists published_at timestamptz;
alter table public.sv_posts add column if not exists poll jsonb;
alter table public.sv_posts add column if not exists media jsonb;
alter table public.sv_posts add column if not exists video_file_id text;
alter table public.sv_posts add column if not exists channel_message_id bigint;
alter table public.sv_posts add column if not exists reaction_count integer not null default 0;
alter table public.sv_posts add column if not exists reactions jsonb;
alter table public.sv_posts add column if not exists layout text;
-- reserved for the future Instagram cross-post adapter (null = not used)
alter table public.sv_posts add column if not exists ig_status text;

create index if not exists sv_posts_due_idx on public.sv_posts (status, scheduled_at);
create index if not exists sv_posts_channel_msg_idx on public.sv_posts (channel_message_id);
create index if not exists sv_plan_items_day_idx on public.sv_plan_items (post_date, status);

-- No policies on purpose: the edge function uses the service role (bypasses RLS); anon/authenticated are locked out.
alter table public.sv_plan enable row level security;
alter table public.sv_plan_items enable row level security;
alter table public.sv_state enable row level security;

alter table public.sv_posts add column if not exists image_lock_at timestamptz; -- one image job per draft
