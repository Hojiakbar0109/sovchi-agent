-- When a row was taken for work (publishing a post / drafting or video-making a plan item).
-- publish_due uses it to recover rows left half-way when the edge worker hit its wall-clock limit.
alter table public.sv_posts add column if not exists claimed_at timestamptz;
alter table public.sv_plan_items add column if not exists claimed_at timestamptz;

create index if not exists sv_posts_claimed_idx on public.sv_posts (status, claimed_at);
create index if not exists sv_plan_items_claimed_idx on public.sv_plan_items (status, claimed_at);
