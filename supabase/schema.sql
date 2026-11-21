-- 工时记录 Worklog · Supabase 同步后端
-- 在 Supabase Dashboard → SQL Editor 里整段执行一次。
-- 设计：space_id 是 32 位随机串，等于同步链接里的钥匙；表不直接开放给 anon，
-- 只通过两个 security definer 函数读写，避免匿名 key 枚举整张表。

create table if not exists public.worklog_spaces (
  space_id   text primary key,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.worklog_spaces enable row level security;

-- 不允许 anon / authenticated 直接 select / insert / update 这张表
revoke all on table public.worklog_spaces from anon, authenticated;

create or replace function public.worklog_get(p_space text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case
    when length(p_space) < 24 then null
    else (
      select jsonb_build_object('payload', payload, 'updated_at', updated_at)
      from public.worklog_spaces
      where space_id = p_space
    )
  end;
$$;

-- 轻量探针：只返回 updated_at，客户端每 8 秒查一次；有变化才拉正文
create or replace function public.worklog_head(p_space text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case
    when length(p_space) < 24 then null
    else (
      select jsonb_build_object('updated_at', updated_at)
      from public.worklog_spaces
      where space_id = p_space
    )
  end;
$$;

create or replace function public.worklog_put(p_space text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(p_space) < 24 then
    raise exception 'space_id too short';
  end if;

  insert into public.worklog_spaces (space_id, payload, updated_at)
  values (p_space, p_payload, now())
  on conflict (space_id) do update
    set payload = excluded.payload,
        updated_at = now();

  return jsonb_build_object('ok', true, 'updated_at', now());
end;
$$;

revoke all on function public.worklog_get(text) from public;
revoke all on function public.worklog_head(text) from public;
revoke all on function public.worklog_put(text, jsonb) from public;
grant execute on function public.worklog_get(text) to anon, authenticated;
grant execute on function public.worklog_head(text) to anon, authenticated;
grant execute on function public.worklog_put(text, jsonb) to anon, authenticated;
