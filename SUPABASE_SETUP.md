# Supabase 同步后端 · 一次性设置

目标：换设备不用导入、不用登录，打开一次同步链接后自动同步。

## 1. 建项目

Supabase Dashboard → **New project**

- Name：`putuswork`
- Database Password：随便生成一个强密码，存到密码管理器（应用不需要它）
- Region：**Southeast Asia (Singapore)** 或离你最近的区域
- Plan：Free

等 1–2 分钟项目初始化完成。

## 2. 建表 + 函数

左侧 **SQL Editor** → New query → 把 `supabase/schema.sql` 全选粘贴进去 → **Run**。

成功后会出现：

- 表 `worklog_spaces`
- 函数 `worklog_get(text)` / `worklog_put(text, jsonb)`
- RLS 已开启，`anon` 不能直接读写表，只能通过函数按 `space_id` 读写

## 3. 拿两个值

左侧 **Project Settings → API**：

- **Project URL**，形如 `https://xxxx.supabase.co`
- **anon public** key（`Project API keys` 里的 anon public）

把这两个值发给我即可。**不要发 `service_role` 密钥**；anon key 本来就是给前端用的公开 key。

## 4. 之后怎么用

我会把同步逻辑接进 `putuswork`：

1. 第一台设备生成一个随机 `space_id`，并显示一次 **同步链接 / 二维码**；
2. 另一台设备打开这个链接一次，之后自动同步；
3. 不用注册、不用登录、不用每次导入；本地仍然优先，断网也能记，联网后补同步；
4. 链接里的 `space_id` 就是钥匙，别公开发到群里。

> 免费版足够个人使用；如果以后想换 Cloudflare 或自建后端，协议不变，只换 `worklog_get` / `worklog_put` 两个接口。
