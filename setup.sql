-- ============================================================
-- 수업 응답 웹앱 · Supabase 설정
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run 하세요.
-- 실행하기 전에 맨 아래 교사 이메일을 자기 이메일로 바꾸세요.
-- 여러 번 실행해도 괜찮습니다(이미 있는 것은 그대로 둡니다).
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- 교사 목록: 여기에 있는 이메일로 로그인한 사람만 교사 화면을 쓸 수 있다.
create table if not exists teachers (
  email text primary key
);

-- 수업(반) 하나. 학생은 수업 코드로 들어온다.
create table if not exists lessons (
  id          uuid primary key default gen_random_uuid(),
  code        text not null check (code ~ '^\S{1,20}$'),
  title       text not null check (length(title) <= 100),
  slide_dir   text not null default 'slides',              -- 슬라이드 그림이 있는 폴더
  slide_count int  not null default 0 check (slide_count between 0 and 300),
  page        int  not null default 1,                     -- 교사가 지금 띄운 쪽
  open        boolean not null default true,               -- 학생이 저장할 수 있는지
  created_at  timestamptz not null default now()
);
create unique index if not exists lessons_code_key on lessons (lower(code));

-- 활동: 슬라이드 질문, 설문, 퀴즈
create table if not exists activities (
  id          uuid primary key default gen_random_uuid(),
  lesson_id   uuid not null references lessons(id) on delete cascade,
  kind        text not null check (kind in ('slide', 'survey', 'quiz')),
  title       text not null check (length(title) <= 100),
  page        int,                                         -- 몇 쪽 아래에 보일지. 비우면 '언제든'
  show_answer boolean not null default true,               -- 퀴즈: 제출 뒤 정답·해설 보여 주기
  named       boolean not null default false,              -- 학생에게 공개할 때 이름 표시
  shared      boolean not null default false,              -- 학생에게 공개 중
  questions   jsonb not null default '[]',
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);

-- 학생: 수업마다 반·번호 + 이름 + 4자리 비밀번호(암호화해서 저장)
create table if not exists students (
  id           uuid primary key default gen_random_uuid(),
  lesson_id    uuid not null references lessons(id) on delete cascade,
  class_no     text not null,
  name         text not null,
  pin_hash     text,                 -- 비어 있으면 다음에 들어올 때 새로 정한다(처음, 또는 교사가 초기화)
  pin_set      boolean generated always as (pin_hash is not null) stored,   -- 교사 화면은 암호 대신 이것만 읽는다
  token        text unique,          -- 입장한 기기가 쓰는 열쇠. 초기화하면 지워져 모든 기기가 나가진다
  fails        int not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  unique (lesson_id, class_no, name)
);

-- 응답: 학생 한 명이 활동 하나에 한 줄
create table if not exists responses (
  student_id  uuid not null references students(id) on delete cascade,
  activity_id uuid not null references activities(id) on delete cascade,
  answers     jsonb not null default '{}',
  score       int,
  total       int,
  updated_at  timestamptz not null default now(),
  primary key (student_id, activity_id)
);

-- ------------------------------------------------------------
-- 보안(RLS): 표는 교사만 직접 읽고 쓴다. 학생은 아래 함수 세 개로만 들어온다.
-- ------------------------------------------------------------
alter table teachers   enable row level security;
alter table lessons    enable row level security;
alter table activities enable row level security;
alter table students   enable row level security;
alter table responses  enable row level security;

create or replace function is_teacher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from teachers where email = lower(auth.jwt() ->> 'email'))
$$;

drop policy if exists teacher_all on lessons;
drop policy if exists teacher_all on activities;
drop policy if exists teacher_all on students;
drop policy if exists teacher_all on responses;
create policy teacher_all on lessons    for all to authenticated using (is_teacher()) with check (is_teacher());
create policy teacher_all on activities for all to authenticated using (is_teacher()) with check (is_teacher());
create policy teacher_all on students   for all to authenticated using (is_teacher()) with check (is_teacher());
create policy teacher_all on responses  for all to authenticated using (is_teacher()) with check (is_teacher());

-- 이름과 번호의 띄어쓰기를 없앤다("3 - 15" → "3-15")
create or replace function tidy(t text) returns text
language sql immutable as $$ select regexp_replace(coalesce(t, ''), '\s', '', 'g') $$;

-- 학생 입장. 처음이거나 초기화된 학생은 p_confirm = true 로 다시 불러야 비밀번호가 정해진다.
-- 5번 틀리면 10분 동안 잠근다.
create or replace function student_enter(p_code text, p_class_no text, p_name text, p_pin text, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  l lessons;
  s students;
  c text := tidy(p_class_no);
  n text := tidy(p_name);
  existed boolean;
begin
  select * into l from lessons where lower(code) = lower(tidy(p_code));
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  if c = '' or n = '' or length(c) > 20 or length(n) > 20 then return jsonb_build_object('error', 'bad_name'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('error', 'bad_pin'); end if;

  select * into s from students where lesson_id = l.id and class_no = c and name = n for update;
  existed := found;

  if not existed or s.pin_hash is null then
    if not p_confirm then return jsonb_build_object('error', 'need_confirm', 'reset', existed); end if;
    if not existed then
      insert into students (lesson_id, class_no, name) values (l.id, c, n) returning * into s;
    end if;
    update students
      set pin_hash = crypt(p_pin, gen_salt('bf')), fails = 0, locked_until = null,
          token = coalesce(token, encode(gen_random_bytes(24), 'hex'))
      where id = s.id returning * into s;
  else
    if s.locked_until > now() then
      return jsonb_build_object('error', 'locked', 'minutes', ceil(extract(epoch from s.locked_until - now()) / 60));
    end if;
    if s.pin_hash <> crypt(p_pin, s.pin_hash) then
      if s.fails + 1 >= 5 then
        update students set fails = 0, locked_until = now() + interval '10 minutes' where id = s.id;
        return jsonb_build_object('error', 'locked', 'minutes', 10);
      end if;
      update students set fails = fails + 1 where id = s.id;
      return jsonb_build_object('error', 'wrong_pin', 'left', 4 - s.fails);
    end if;
    update students
      set fails = 0, locked_until = null, token = coalesce(token, encode(gen_random_bytes(24), 'hex'))
      where id = s.id returning * into s;
  end if;

  return jsonb_build_object('token', s.token, 'class_no', s.class_no, 'name', s.name, 'code', l.code);
end $$;

-- 학생 화면에 필요한 것 전부: 수업 상태, 활동, 내 응답, 공개된 친구들 응답.
-- 퀴즈 정답과 해설은 그 학생이 제출한 뒤(그리고 '정답 보여 주기'가 켜져 있을 때)에만 보낸다.
create or replace function student_state(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s students;
  l lessons;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into l from lessons where id = s.lesson_id;

  return jsonb_build_object(
    'me', jsonb_build_object('class_no', s.class_no, 'name', s.name),
    'lesson', jsonb_build_object('code', l.code, 'title', l.title, 'slide_dir', l.slide_dir,
                                 'slide_count', l.slide_count, 'page', l.page, 'open', l.open),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'kind', a.kind, 'title', a.title, 'page', a.page, 'named', a.named, 'shared', a.shared,
        'questions', case
          when a.kind = 'quiz' and a.show_answer and r.student_id is not null then a.questions
          else (select coalesce(jsonb_agg(q - 'answer' - 'explain'), '[]'::jsonb) from jsonb_array_elements(a.questions) q)
        end,
        'mine', r.answers, 'score', r.score, 'total', r.total, 'saved_at', r.updated_at,
        'others', case when a.shared then (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'name', case when a.named then o.class_no || ' ' || o.name end,
                   'answers', x.answers) order by x.updated_at), '[]'::jsonb)
          from responses x join students o on o.id = x.student_id
          where x.activity_id = a.id) end
      ) order by a.page nulls last, a.sort, a.created_at)
      from activities a
      left join responses r on r.activity_id = a.id and r.student_id = s.id
      where a.lesson_id = l.id), '[]'::jsonb)
  );
end $$;

-- 학생 응답 저장. 제출이 열려 있을 때만. 퀴즈는 한 번만 제출하고 서버에서 채점한다.
create or replace function student_save(p_token text, p_activity uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s students;
  l lessons;
  a activities;
  sc int;
  tot int;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into a from activities where id = p_activity and lesson_id = s.lesson_id;
  if not found then return jsonb_build_object('error', 'no_activity'); end if;
  select * into l from lessons where id = s.lesson_id;
  if not l.open then return jsonb_build_object('error', 'closed'); end if;
  if jsonb_typeof(p_answers) is distinct from 'object' or octet_length(p_answers::text) > 20000 then
    return jsonb_build_object('error', 'too_big');
  end if;

  if a.kind = 'quiz' then
    if exists (select 1 from responses where student_id = s.id and activity_id = a.id) then
      return jsonb_build_object('error', 'already');
    end if;
    select count(*) filter (where q ? 'answer'),
           count(*) filter (where q ? 'answer' and p_answers -> (q ->> 'id') = q -> 'answer')
      into tot, sc
      from jsonb_array_elements(a.questions) q;
  end if;

  insert into responses (student_id, activity_id, answers, score, total, updated_at)
    values (s.id, a.id, p_answers, sc, tot, now())
    on conflict (student_id, activity_id)
    do update set answers = excluded.answers, score = excluded.score, total = excluded.total, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

revoke all on function student_enter(text, text, text, text, boolean) from public;
revoke all on function student_state(text) from public;
revoke all on function student_save(text, uuid, jsonb) from public;
grant execute on function student_enter(text, text, text, text, boolean) to anon, authenticated;
grant execute on function student_state(text) to anon, authenticated;
grant execute on function student_save(text, uuid, jsonb) to anon, authenticated;
grant execute on function is_teacher() to authenticated;

-- ------------------------------------------------------------
-- 교사 이메일: 아래를 자기 이메일로 바꾸세요(소문자로). 여러 명이면 줄을 더하면 됩니다.
-- ------------------------------------------------------------
insert into teachers (email) values ('lihyosong@gmail.com') on conflict do nothing;
