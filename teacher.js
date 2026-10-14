// 교사 화면: 로그인 → 수업 고르기 → [수업 진행] [질문·설문 만들기] [학생 관리] [수업 설정]
// 수업 진행·학생 관리 탭은 3초마다 응답을 다시 읽어 온다.

const app = document.getElementById("app");
const POLL_MS = 3000;

let lessons = [];
let lesson = null;        // 지금 고른 수업(없으면 새 수업 만들기)
let activities = [];
let students = [];
let responses = [];
let tab = localStorage.getItem("cra-tab") || "run";
let timer = null;
let editing = null;       // 만들기 탭에서 고치는 중인 활동(사본)
let main = null;

if (!sb) notConfigured(app);
else init();

// ---------- 로그인 ----------
async function init() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return showLogin();
  const { data: ok, error } = await sb.rpc("is_teacher");
  if (error || !ok) {
    return app.replaceChildren(h("main", { class: "narrow" }, h("section", { class: "card stack" },
      h("h1", {}, "교사로 등록되지 않은 계정입니다"),
      h("p", {}, (data.session.user.email || "") + " 이메일이 teachers 표에 없습니다. setup.sql 맨 아래에 이 이메일을 넣고 다시 실행하세요."),
      error ? h("p", { class: "error" }, error.message) : null,
      h("button", { class: "ghost", type: "button", async onclick() { await sb.auth.signOut(); location.reload(); } }, "로그아웃"))));
  }
  await loadLessons(localStorage.getItem("cra-lesson"));
  document.addEventListener("keydown", (e) => {
    if (tab !== "run" || !lesson || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === "ArrowRight") setPage(lesson.page + 1);
    if (e.key === "ArrowLeft") setPage(lesson.page - 1);
  });
}

function showLogin() {
  const email = h("input", { type: "email", autocomplete: "username", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const msg = h("p", { class: "msg" });
  app.replaceChildren(h("main", { class: "narrow" },
    h("header", { class: "intro" }, h("p", { class: "eyebrow" }, "교사용"), h("h1", {}, "로그인")),
    h("form", {
      class: "card stack",
      async onsubmit(e) {
        e.preventDefault();
        msg.textContent = "로그인 중…";
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
        if (error) msg.textContent = "로그인하지 못했습니다: " + error.message;
        else init();
      },
    }, h("label", {}, "이메일", email), h("label", {}, "비밀번호", pw),
      h("button", { class: "primary big", type: "submit" }, "로그인"), msg),
    h("p", { class: "muted small center" }, "교사 계정은 Supabase 대시보드 → Authentication → Users 에서 만듭니다.")));
}

// ---------- 데이터 ----------
async function loadLessons(selectId) {
  const { data, error } = await sb.from("lessons").select("*").order("created_at");
  if (error) return fatal(error);
  lessons = data;
  lesson = lessons.find((l) => l.id === selectId) || lessons[0] || null;
  if (!lesson) tab = "settings";
  await loadLesson();
}

async function loadLesson() {
  activities = [];
  students = [];
  responses = [];
  editing = null;
  if (lesson) {
    localStorage.setItem("cra-lesson", lesson.id);
    const { data, error } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
    if (error) return fatal(error);
    activities = sortActivities(data);
    await loadResponses();
  }
  draw();
}

function sortActivities(list) {
  return list.slice().sort((x, y) => (x.page ?? 1e9) - (y.page ?? 1e9) || x.sort - y.sort || x.created_at.localeCompare(y.created_at));
}

async function loadResponses() {
  if (!lesson) return;
  const st = await sb.from("students").select("id,class_no,name,pin_set,fails,locked_until,created_at").eq("lesson_id", lesson.id);
  if (st.error) return fatal(st.error);
  students = st.data.sort((x, y) => x.class_no.localeCompare(y.class_no, "ko", { numeric: true }) || x.name.localeCompare(y.name, "ko"));
  const ids = activities.map((a) => a.id);
  if (!ids.length) { responses = []; return; }
  const rs = await sb.from("responses").select("*").in("activity_id", ids);
  if (rs.error) return fatal(rs.error);
  responses = rs.data;
}

function schedule() {
  clearTimeout(timer);
  if (!lesson || (tab !== "run" && tab !== "students")) return;
  timer = setTimeout(async () => {
    await loadResponses();
    if (tab === "run") refreshRun();
    if (tab === "students") drawStudents();
    schedule();
  }, POLL_MS);
}

function fatal(error) {
  console.error(error);
  const box = h("p", { class: "banner bad" }, "서버 오류: " + (error.message || error) + " · 새로고침해 보세요.");
  (main || app).prepend(box);
}

async function save(table, row, id) {
  const q = id ? sb.from(table).update(row).eq("id", id) : sb.from(table).insert(row);
  const { data, error } = await q.select();
  if (error) { alert("저장하지 못했습니다: " + error.message); return null; }
  return data[0];
}

const nameOf = (s) => s.class_no + " " + s.name;
const studentById = (id) => students.find((s) => s.id === id);
const docsOf = (a) => responses.filter((r) => r.activity_id === a.id && studentById(r.student_id))
  .map((r) => ({ name: nameOf(studentById(r.student_id)), answers: r.answers, r }));
const whereText = (a) => a.page == null ? "언제든" : a.page + "쪽";

// ---------- 틀 ----------
function draw() {
  clearTimeout(timer);
  const pick = h("select", {
    "aria-label": "수업 고르기",
    async onchange() {
      if (pick.value === "new") { lesson = null; tab = "settings"; }
      else lesson = lessons.find((l) => l.id === pick.value);
      await loadLesson();
    },
  }, lessons.map((l) => h("option", { value: l.id, selected: lesson && l.id === lesson.id }, l.title + " (" + l.code + ")")),
    h("option", { value: "new", selected: !lesson }, "+ 새 수업 만들기"));
  const tabs = [["run", "수업 진행"], ["build", "질문·설문 만들기"], ["students", "학생 관리"], ["settings", "수업 설정"]];
  main = h("main", { class: "wide" });
  app.replaceChildren(
    h("header", { class: "top" },
      h("div", { class: "top-title" }, h("span", { class: "eyebrow" }, "교사용"), pick),
      h("nav", { class: "tabs" }, tabs.map(([k, label]) => h("button", {
        type: "button", class: tab === k ? "tab on" : "tab", disabled: !lesson && k !== "settings",
        onclick() { tab = k; localStorage.setItem("cra-tab", k); draw(); },
      }, label))),
      h("button", { class: "link", type: "button", async onclick() { await sb.auth.signOut(); location.reload(); } }, "로그아웃")),
    main);
  if (!lesson) tab = "settings";
  ({ run: drawRun, build: drawBuild, students: drawStudents, settings: drawSettings })[tab]();
  schedule();
}

// ---------- 수업 진행 ----------
let run = null;

function drawRun() {
  const img = h("img", { class: "slide", alt: "" });
  const where = h("span", { class: "where" });
  const prev = h("button", { class: "ghost", type: "button", onclick() { setPage(lesson.page - 1); } }, "◀ 이전");
  const next = h("button", { class: "primary", type: "button", onclick() { setPage(lesson.page + 1); } }, "다음 ▶");
  const openBtn = h("button", { type: "button", onclick() { setLesson({ open: !lesson.open }); } });
  const openText = h("span", {});
  const stage = h("div", { class: "stage" }, img);
  const panel = h("div", { class: "stack" });
  const hasSlides = lesson.slide_count > 0;
  main.replaceChildren(h("div", { class: "run" },
    h("div", { class: "run-left stack" },
      hasSlides ? stage : h("p", { class: "card muted" }, "슬라이드가 없는 수업입니다. 학생 화면에는 모든 활동이 보입니다."),
      hasSlides ? h("nav", { class: "pager" }, prev, where, next, h("span", { class: "spacer" }),
        h("button", { class: "ghost", type: "button", onclick() { if (stage.requestFullscreen) stage.requestFullscreen(); } }, "전체 화면")) : null,
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick: showJoin }, "학생 접속 주소·QR"),
        h("button", { class: "ghost", type: "button", onclick() { downloadCSV(activities, lesson.code + "_전체응답"); } }, "전체 응답 CSV")),
      hasSlides ? h("p", { class: "muted small" }, "학생 화면은 여기서 띄운 쪽을 따라갑니다. 키보드 ← → 로도 넘길 수 있습니다.") : null),
    h("aside", { class: "run-right stack" },
      h("section", { class: "card row between" }, openText, openBtn),
      panel)));
  run = { img, where, prev, next, openBtn, openText, panel, blocks: new Map() };
  refreshRun();
}

function refreshRun() {
  if (!run) return;
  const L = lesson;
  if (L.slide_count > 0) {
    run.img.src = slideSrc(L, L.page);
    run.img.alt = "슬라이드 " + L.page;
    run.where.textContent = L.page + " / " + L.slide_count;
    run.prev.disabled = L.page <= 1;
    run.next.disabled = L.page >= L.slide_count;
    if (L.page < L.slide_count) new Image().src = slideSrc(L, L.page + 1);
  }
  run.openText.replaceChildren(h("strong", {}, L.open ? "제출 받는 중" : "제출 닫힘"),
    h("span", { class: "muted small" }, " · 입장 " + students.length + "명"));
  run.openBtn.className = L.open ? "ghost" : "primary";
  run.openBtn.textContent = L.open ? "제출 마감" : "제출 열기";

  const shown = activities.filter((a) => L.slide_count === 0 || a.page === L.page || a.page == null);
  run.panel.replaceChildren(...(shown.length ? shown.map(runBlock)
    : [h("p", { class: "card muted" }, L.page + "쪽에는 활동이 없습니다. 「질문·설문 만들기」에서 추가하세요.")]));
}

function runBlock(a) {
  const docs = docsOf(a);
  const scored = docs.filter((d) => d.r.total);
  const avg = scored.length ? (scored.reduce((s, d) => s + d.r.score / d.r.total, 0) / scored.length * 100).toFixed(0) + "점" : null;
  return h("section", { class: "card stack" },
    h("div", { class: "row between" },
      h("div", {},
        h("p", { class: "muted small" }, KIND_NAME[a.kind] + " · " + whereText(a)),
        h("h2", {}, a.title)),
      h("button", {
        type: "button", class: a.shared ? "ghost" : "primary",
        async onclick() { await setActivity(a, { shared: !a.shared }); },
      }, a.shared ? "공개 끝내기" : "학생에게 공개")),
    h("p", { class: a.shared ? "pill on" : "pill" }, a.shared ? "학생에게 공개 중 (" + (a.named ? "이름과 함께" : "이름 없이") + ")" : "학생에게는 보이지 않음"),
    h("p", { class: "muted small" }, "응답 " + docs.length + " / " + students.length + "명" + (avg ? " · 평균 " + avg : "")),
    summaryView(a.questions, docs),
    h("div", { class: "row" },
      h("button", { class: "ghost", type: "button", onclick() { openModal(a.title, h("div", { class: "big-view" }, summaryView(a.questions, docsOf(a)))); } }, "크게 보기"),
      h("button", { class: "ghost", type: "button", onclick() { openModal(a.title + " · 학생별", responseTable(a)); } }, "학생별 표"),
      h("button", { class: "ghost", type: "button", onclick() { downloadCSV([a], lesson.code + "_" + a.title); } }, "CSV")));
}

function responseTable(a) {
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "반·번호"), h("th", {}, "이름"), a.kind === "quiz" ? h("th", {}, "점수") : null,
      a.questions.map((q, i) => h("th", {}, (i + 1) + ". " + q.text)), h("th", {}, "저장"))),
    h("tbody", {}, students.map((s) => {
      const r = responses.find((x) => x.activity_id === a.id && x.student_id === s.id);
      return h("tr", { class: r ? "" : "missing" }, h("td", {}, s.class_no), h("td", {}, s.name),
        a.kind === "quiz" ? h("td", {}, r && r.total ? r.score + "/" + r.total : "") : null,
        a.questions.map((q) => h("td", {}, r ? answerText(r.answers[q.id]) : "")),
        h("td", {}, r ? fmtTime(r.updated_at) : "미제출"));
    }))));
}

async function setPage(n) {
  n = Math.min(Math.max(n, 1), Math.max(lesson.slide_count, 1));
  if (n === lesson.page) return;
  await setLesson({ page: n });
}

async function setLesson(change) {
  Object.assign(lesson, change);
  refreshRun();
  const { error } = await sb.from("lessons").update(change).eq("id", lesson.id);
  if (error) fatal(error);
}

async function setActivity(a, change) {
  Object.assign(a, change);
  refreshRun();
  const { error } = await sb.from("activities").update(change).eq("id", a.id);
  if (error) fatal(error);
}

function joinUrl(l) {
  return new URL("index.html?c=" + encodeURIComponent(l.code), location.href).href;
}

function showJoin() {
  const url = joinUrl(lesson);
  const qr = h("div", { class: "qr" });
  openModal("학생 접속", h("div", { class: "join" }, qr,
    h("div", { class: "stack" },
      h("p", { class: "join-code" }, "수업 코드 ", h("strong", {}, lesson.code)),
      h("p", { class: "join-url" }, url),
      h("button", { class: "ghost", type: "button", onclick(e) { navigator.clipboard.writeText(url).then(() => { e.target.textContent = "복사했습니다"; }); } }, "주소 복사"))));
  if (window.QRCode) new QRCode(qr, { text: url, width: 320, height: 320 });
  else qr.textContent = "QR을 만들지 못했습니다(인터넷 연결 확인).";
}

// ---------- 질문·설문 만들기 ----------
const newId = () => Math.random().toString(36).slice(2, 8);
const newQuestion = (type) => ({ id: newId(), type: type || "choice", text: "", options: ["", ""] });

function drawBuild() {
  const list = h("div", { class: "stack" }, activities.length ? activities.map((a) => h("button", {
    type: "button", class: "act-item" + (editing && editing.id === a.id ? " on" : ""),
    onclick() { editing = JSON.parse(JSON.stringify(a)); drawBuild(); },
  }, h("span", { class: "muted small" }, KIND_NAME[a.kind] + " · " + whereText(a)), h("span", {}, a.title))) : h("p", { class: "muted small" }, "아직 활동이 없습니다."));
  const kinds = h("div", { class: "kinds" }, Object.entries({ slide: "쪽 아래에 붙는 질문", survey: "정답 없는 설문", quiz: "정답·자동 채점" }).map(([k, sub]) =>
    h("button", {
      type: "button", class: "kind",
      onclick() {
        editing = { kind: k, title: "", page: lesson.slide_count ? lesson.page : null, show_answer: true, named: false, shared: false, questions: [newQuestion(k === "survey" ? "long" : "choice")] };
        drawBuild();
      },
    }, h("strong", {}, KIND_NAME[k]), h("span", {}, sub))));
  main.replaceChildren(h("div", { class: "build" },
    h("aside", { class: "stack" },
      h("section", { class: "card stack" }, h("h2", {}, "새로 만들기"), kinds),
      h("section", { class: "card stack" }, h("h2", {}, "이 수업의 활동"), list)),
    editing ? editor() : h("section", { class: "card muted" }, "왼쪽에서 새로 만들거나, 고칠 활동을 고르세요.")));
}

function editor() {
  const e = editing;
  const hasResponses = e.id && responses.some((r) => r.activity_id === e.id);
  const msg = h("p", { class: "error" });
  const redraw = () => { const y = scrollY; drawBuild(); scrollTo(0, y); };

  const title = h("input", { type: "text", maxlength: 100, value: e.title, placeholder: "예: 예상해 보기", oninput() { e.title = title.value; } });
  const pageIn = h("input", { type: "number", min: 1, max: Math.max(lesson.slide_count, 1), value: e.page ?? lesson.page, class: "num", oninput() { e.page = parseInt(pageIn.value, 10) || 1; } });
  const placeSel = h("select", {
    onchange() { e.page = placeSel.value === "page" ? (parseInt(pageIn.value, 10) || 1) : null; redraw(); },
  }, h("option", { value: "page", selected: e.page != null }, "슬라이드 쪽 아래"), h("option", { value: "any", selected: e.page == null }, "언제든 (모든 쪽 아래 목록)"));

  const qs = e.questions.map((q, i) => {
    const typeSel = h("select", {
      "aria-label": "질문 종류",
      onchange() { q.type = typeSel.value; if (q.type === "choice" || q.type === "multi") { q.options = q.options && q.options.length ? q.options : ["", ""]; } delete q.answer; redraw(); },
    }, Object.entries(TYPE_NAME).map(([k, v]) => h("option", { value: k, selected: q.type === k }, v)));
    const move = (d) => { const j = i + d; if (j < 0 || j >= e.questions.length) return; [e.questions[i], e.questions[j]] = [e.questions[j], e.questions[i]]; redraw(); };
    const text = h("input", { type: "text", maxlength: 300, value: q.text, placeholder: "질문을 입력하세요", oninput() { q.text = text.value; } });
    const choice = q.type === "choice" || q.type === "multi";
    const opts = choice ? h("textarea", {
      rows: Math.max(3, q.options.length + 1),
      onchange() {
        q.options = opts.value.split("\n").map((x) => x.trim()).filter(Boolean);
        if (q.answer != null) {
          q.answer = q.type === "choice" ? (q.options.includes(q.answer) ? q.answer : undefined) : [].concat(q.answer).filter((x) => q.options.includes(x));
          if (q.answer === undefined || (Array.isArray(q.answer) && !q.answer.length)) delete q.answer;
        }
        redraw();
      },
    }, q.options.filter(Boolean).join("\n")) : null;
    const answerPick = e.kind === "quiz" && choice && q.options.filter(Boolean).length ? h("fieldset", { class: "options" },
      h("legend", {}, "정답 표시" + (q.type === "multi" ? " (모두 고르기)" : "")),
      q.options.filter(Boolean).map((o) => h("label", { class: "option" + ([].concat(q.answer ?? []).includes(o) ? " right" : "") },
        h("input", {
          type: q.type === "choice" ? "radio" : "checkbox", name: "ans-" + q.id, checked: [].concat(q.answer ?? []).includes(o),
          onchange(ev) {
            if (q.type === "choice") q.answer = o;
            else {
              const now = q.options.filter((x) => (x === o ? ev.target.checked : [].concat(q.answer ?? []).includes(x)));
              if (now.length) q.answer = now; else delete q.answer;
            }
            redraw();
          },
        }), h("span", {}, o)))) : null;
    const explain = e.kind === "quiz" ? h("input", { type: "text", maxlength: 300, value: q.explain || "", placeholder: "해설 (선택)", oninput() { q.explain = explain.value.trim() || undefined; } }) : null;
    return h("article", { class: "q-edit stack" },
      h("div", { class: "row" }, h("strong", {}, "질문 " + (i + 1)), typeSel, h("span", { class: "spacer" }),
        h("button", { class: "link", type: "button", onclick() { move(-1); } }, "위로"),
        h("button", { class: "link", type: "button", onclick() { move(1); } }, "아래로"),
        h("button", { class: "link danger", type: "button", onclick() { if (e.questions.length > 1) { e.questions.splice(i, 1); redraw(); } } }, "삭제")),
      h("label", {}, "질문", text),
      choice ? h("label", {}, "보기 (한 줄에 하나씩)", opts) : null,
      answerPick,
      explain ? h("label", {}, "해설", explain) : null,
      e.kind === "quiz" && !choice ? h("p", { class: "muted small" }, "글로 답하는 질문은 자동 채점하지 않습니다.") : null);
  });

  async function saveActivity() {
    e.title = e.title.trim();
    if (!e.title) { msg.textContent = "제목을 입력하세요."; return; }
    for (const [i, q] of e.questions.entries()) {
      q.text = (q.text || "").trim();
      if (!q.text) { msg.textContent = (i + 1) + "번 질문을 입력하세요."; return; }
      if (q.type === "choice" || q.type === "multi") {
        q.options = q.options.map((x) => x.trim()).filter(Boolean);
        if (q.options.length < 2) { msg.textContent = (i + 1) + "번 질문의 보기를 두 개 이상 적으세요."; return; }
        if (new Set(q.options).size !== q.options.length) { msg.textContent = (i + 1) + "번 질문에 같은 보기가 두 번 있습니다."; return; }
      } else { delete q.options; delete q.answer; }
    }
    const row = { kind: e.kind, title: e.title, page: e.page, show_answer: e.show_answer, named: e.named, questions: e.questions };
    if (!e.id) { row.lesson_id = lesson.id; row.sort = activities.length; }
    const saved = await save("activities", row, e.id);
    if (!saved) return;
    const { data } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
    activities = sortActivities(data || []);
    editing = JSON.parse(JSON.stringify(saved));
    drawBuild();
    flash("저장했습니다.");
  }

  async function removeActivity() {
    if (!confirm("「" + e.title + "」을(를) 지울까요? 학생 응답도 함께 지워집니다.")) return;
    const { error } = await sb.from("activities").delete().eq("id", e.id);
    if (error) { msg.textContent = error.message; return; }
    activities = activities.filter((a) => a.id !== e.id);
    editing = null;
    drawBuild();
  }

  return h("section", { class: "card stack editor" },
    h("p", { class: "muted small" }, KIND_NAME[e.kind] + (e.id ? " 고치기" : " 새로 만들기")),
    hasResponses ? h("p", { class: "banner" }, "이미 학생 응답이 있습니다. 질문이나 보기를 바꾸면 기존 응답과 맞지 않을 수 있습니다.") : null,
    h("div", { class: "row wrap" },
      h("label", { class: "grow" }, "제목", title),
      lesson.slide_count ? h("label", {}, "어디에 보일까요?", h("div", { class: "row" }, placeSel, e.page != null ? pageIn : null, e.page != null ? h("span", {}, "쪽") : null)) : null),
    h("div", { class: "row wrap" },
      e.kind === "quiz" ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: e.show_answer, onchange(ev) { e.show_answer = ev.target.checked; } }), "제출 뒤 정답과 해설 보여 주기") : null,
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: e.named, onchange(ev) { e.named = ev.target.checked; } }), "학생에게 공개할 때 이름 표시")),
    qs,
    h("div", { class: "row" }, Object.entries(TYPE_NAME).map(([k, v]) =>
      h("button", { class: "ghost", type: "button", onclick() { e.questions.push(newQuestion(k)); redraw(); } }, "+ " + v))),
    msg,
    h("div", { class: "row between" },
      e.id ? h("button", { class: "ghost danger", type: "button", onclick: removeActivity }, "활동 지우기") : h("span", {}),
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick() { editing = null; drawBuild(); } }, "닫기"),
        h("button", { class: "primary", type: "button", onclick: saveActivity }, "저장"))));
}

function flash(text) {
  const el = h("p", { class: "toast" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 1800);
}

// ---------- 학생 관리 ----------
function drawStudents() {
  const now = Date.now();
  const rows = students.map((s) => {
    const mine = responses.filter((r) => r.student_id === s.id);
    const last = mine.reduce((t, r) => (r.updated_at > t ? r.updated_at : t), "");
    const locked = s.locked_until && Date.parse(s.locked_until) > now;
    const status = locked ? h("span", { class: "tag warn" }, "잠김 · " + Math.ceil((Date.parse(s.locked_until) - now) / 60000) + "분 남음")
      : !s.pin_set ? h("span", { class: "tag info" }, "초기화됨 · 새 비밀번호 기다리는 중")
      : h("span", { class: "tag ok" }, "정상");
    return h("tr", { class: locked ? "locked" : "" },
      h("td", {}, s.class_no), h("td", {}, s.name),
      h("td", {}, mine.length + " / " + activities.length), h("td", {}, fmtTime(last)), h("td", {}, status),
      h("td", { class: "actions" },
        h("button", {
          class: locked ? "primary" : "ghost", type: "button", disabled: !s.pin_set && !locked,
          async onclick() {
            if (!confirm(nameOf(s) + " 학생의 비밀번호를 초기화할까요?\n쓴 답은 그대로 남고, 다음에 들어올 때 새 비밀번호를 정합니다.")) return;
            const { error } = await sb.from("students").update({ pin_hash: null, token: null, fails: 0, locked_until: null }).eq("id", s.id);
            if (error) return alert(error.message);
            await loadResponses();
            drawStudents();
            flash("초기화했습니다.");
          },
        }, "비밀번호 초기화"),
        h("button", {
          class: "link danger", type: "button",
          async onclick() {
            if (!confirm(nameOf(s) + " 학생을 지울까요? 이 학생의 응답도 모두 지워집니다.")) return;
            const { error } = await sb.from("students").delete().eq("id", s.id);
            if (error) return alert(error.message);
            await loadResponses();
            drawStudents();
          },
        }, "삭제")));
  });
  main.replaceChildren(h("section", { class: "card stack" },
    h("div", { class: "row between wrap" },
      h("h2", {}, "학생 " + students.length + "명"),
      h("p", { class: "muted small" }, "비밀번호는 암호화되어 있어 교사도 볼 수 없습니다. 잊은 학생은 초기화해 주세요.")),
    students.length ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["반·번호", "이름", "저장한 활동", "마지막 저장", "상태", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows))) : h("p", { class: "muted" }, "아직 입장한 학생이 없습니다.")));
}

// ---------- 수업 설정 ----------
function drawSettings() {
  const l = lesson || { code: "", title: "", slide_dir: "slides", slide_count: 0 };
  const code = h("input", { type: "text", maxlength: 20, value: l.code, placeholder: "예: 3반 (띄어쓰기 없이)" });
  const title = h("input", { type: "text", maxlength: 100, value: l.title, placeholder: "예: 2학년 3반 · 열의 이동" });
  const dir = h("input", { type: "text", maxlength: 100, value: l.slide_dir });
  const count = h("input", { type: "number", min: 0, max: 300, value: l.slide_count, class: "num" });
  const msg = h("p", { class: "error" });

  async function submit(ev) {
    ev.preventDefault();
    const row = { code: code.value.replace(/\s/g, ""), title: title.value.trim(), slide_dir: dir.value.trim() || "slides", slide_count: parseInt(count.value, 10) || 0 };
    if (!row.code || !row.title) { msg.textContent = "수업 코드와 제목을 입력하세요."; return; }
    const saved = await save("lessons", row, lesson && lesson.id);
    if (!saved) return;
    if (!lesson) tab = "build";
    await loadLessons(saved.id);
    flash("저장했습니다.");
  }

  async function duplicate() {
    const newCode = (prompt("복제한 수업의 새 수업 코드 (예: 4반)") || "").replace(/\s/g, "");
    if (!newCode) return;
    const copy = await save("lessons", { code: newCode, title: lesson.title.replace(/\S*반/, newCode), slide_dir: lesson.slide_dir, slide_count: lesson.slide_count });
    if (!copy) return;
    if (activities.length) {
      const { error } = await sb.from("activities").insert(activities.map((a) => ({
        lesson_id: copy.id, kind: a.kind, title: a.title, page: a.page, show_answer: a.show_answer, named: a.named, questions: a.questions, sort: a.sort,
      })));
      if (error) alert("활동을 복사하지 못했습니다: " + error.message);
    }
    await loadLessons(copy.id);
    flash("복제했습니다. 제목을 확인하세요.");
  }

  async function remove() {
    const typed = prompt("수업을 지우면 활동, 학생, 응답이 모두 지워집니다.\n지우려면 수업 코드 「" + lesson.code + "」를 입력하세요.");
    if (typed !== lesson.code) return;
    const { error } = await sb.from("lessons").delete().eq("id", lesson.id);
    if (error) return alert(error.message);
    await loadLessons(null);
  }

  main.replaceChildren(h("div", { class: "stack narrowish" },
    h("form", { class: "card stack", onsubmit: submit },
      h("h2", {}, lesson ? "수업 설정" : "새 수업 만들기"),
      h("label", {}, "수업 코드 (학생이 입력하거나 링크에 들어감)", code),
      h("label", {}, "수업 제목", title),
      h("div", { class: "row wrap" },
        h("label", { class: "grow" }, "슬라이드 폴더", dir),
        h("label", {}, "슬라이드 수 (없으면 0)", count)),
      h("p", { class: "muted small" }, "슬라이드는 PPT에서 PNG로 내보낸 그림을 이 폴더에 1.png, 2.png … 이름으로 올립니다. 수업마다 폴더를 나누려면 slides/3반 처럼 적으세요. PowerPoint가 내보낸 이름(슬라이드1.PNG …)을 그대로 쓰려면 slides/슬라이드{n}.PNG 처럼 {n}을 넣으세요."),
      msg,
      h("button", { class: "primary big", type: "submit" }, lesson ? "저장" : "수업 만들기")),
    lesson ? h("section", { class: "card stack" },
      h("h2", {}, "학생 접속"),
      h("p", { class: "join-url" }, joinUrl(lesson)),
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick: showJoin }, "QR 크게 보기"),
        h("button", { class: "ghost", type: "button", onclick: duplicate }, "다른 반용으로 복제"),
        h("button", { class: "ghost danger", type: "button", onclick: remove }, "수업 지우기"))) : null));
}

// ---------- CSV ----------
function downloadCSV(acts, fileName) {
  const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const head = ["반·번호", "이름"];
  acts.forEach((a) => {
    if (a.kind === "quiz") head.push(a.title + " · 점수");
    a.questions.forEach((q, i) => head.push(a.title + " · " + (i + 1) + ". " + q.text));
    head.push(a.title + " · 저장 시각");
  });
  const lines = [head.map(cell).join(",")];
  students.forEach((s) => {
    const row = [s.class_no, s.name];
    acts.forEach((a) => {
      const r = responses.find((x) => x.activity_id === a.id && x.student_id === s.id);
      if (a.kind === "quiz") row.push(r && r.total ? r.score + "/" + r.total : "");
      a.questions.forEach((q) => row.push(r ? answerText(r.answers[q.id]) : ""));
      row.push(r ? new Date(r.updated_at).toLocaleString("ko-KR") : "");
    });
    lines.push(row.map(cell).join(","));
  });
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: fileName.replace(/[\\/:*?"<>|]/g, "_") + ".csv" });
  document.body.append(a);
  a.click();
  a.remove();
}
