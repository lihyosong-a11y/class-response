// 교사 화면(버전 2): 로그인 → 수업 고르기 → [수업 진행] [질문·설문 만들기] [학생 관리] [수업 설정]
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
let me = null;            // 로그인한 교사(auth user)

if (!sb) notConfigured(app);
else init();

// ---------- 로그인 ----------
async function init() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return showLogin();
  me = data.session.user;
  const { data: ok, error } = await sb.rpc("is_teacher");
  if (error || !ok) {
    return app.replaceChildren(h("main", { class: "narrow" }, h("section", { class: "card stack" },
      h("h1", {}, "교사로 등록되지 않은 계정입니다"),
      h("p", {}, (me.email || "") + " 이메일이 teachers 표에 없습니다. setup.sql 맨 아래에 이 이메일을 넣고 다시 실행하세요."),
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
  const st = await sb.from("students").select("id,class_no,name,pin_set,fails,locked_until,created_at,last_seen").eq("lesson_id", lesson.id);
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
const whereText = (a) => a.page == null ? "언제든" : a.page_to > a.page ? a.page + "~" + a.page_to + "쪽" : a.page + "쪽";

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
  }, lessons.map((l) => h("option", { value: l.id, selected: lesson && l.id === lesson.id }, (l.kind === "survey" ? "[설문] " : "") + l.title + " (" + l.code + ")")),
    h("option", { value: "new", selected: !lesson }, "+ 새 수업 만들기"));
  const tabs = [["run", "수업 진행"], ["build", "질문·설문 만들기"], ["students", "학생 관리"], ["settings", "수업 설정"]];
  if (!tabs.some(([k]) => k === tab)) tab = "run";
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
  const roster = h("section", { class: "card stack" });
  const hasSlides = lesson.slide_count > 0;
  main.replaceChildren(h("div", { class: "run" },
    h("div", { class: "run-left stack" },
      hasSlides ? stage : h("p", { class: "card muted" }, lesson.kind === "survey" ? "설문 전용입니다. 학생 화면에는 모든 설문이 보입니다." : "슬라이드가 없는 수업입니다. 학생 화면에는 모든 활동이 보입니다."),
      hasSlides ? h("nav", { class: "pager" }, prev, where, next, h("span", { class: "spacer" }),
        h("button", { class: "ghost", type: "button", onclick() { if (stage.requestFullscreen) stage.requestFullscreen(); } }, "전체 화면")) : null,
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick: showJoin }, "학생 접속 주소·QR"),
        h("button", { class: "ghost", type: "button", onclick() { downloadCSV(activities, lesson.code + "_전체응답"); } }, "전체 응답 CSV")),
      hasSlides ? h("p", { class: "muted small" }, "학생 화면은 여기서 띄운 쪽을 따라갑니다. 키보드 ← → 로도 넘길 수 있습니다.") : null),
    h("aside", { class: "run-right stack" },
      h("section", { class: "card row between" }, openText, openBtn),
      roster,
      panel)));
  run = { img, where, prev, next, openBtn, openText, panel, roster, blocks: new Map() };
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

  const shown = activities.filter((a) => L.slide_count === 0 || onPage(a, L.page) || a.page == null);
  drawRoster(shown);
  run.panel.replaceChildren(...(shown.length ? shown.map(runBlock)
    : [h("p", { class: "card muted" }, L.page + "쪽에는 활동이 없습니다. 「질문·설문 만들기」에서 추가하세요.")]));
}

// 접속한 학생: 초록 = 지금 화면을 열어 둔 학생(20초 안에 서버에 물어봄), ✓ = 이 쪽 활동에 답함
const ONLINE_MS = 20000;
function rosterChips(shown, big) {
  const now = Date.now();
  const ids = new Set(shown.map((a) => a.id));
  return h("div", { class: "roster" + (big ? " big" : "") }, students.map((s) => {
    const on = s.last_seen && now - Date.parse(s.last_seen) < ONLINE_MS;
    const done = shown.length && responses.some((r) => r.student_id === s.id && ids.has(r.activity_id));
    return h("span", { class: "chip" + (on ? " on" : "") + (done ? " done" : ""), title: on ? "접속 중" : "접속 끊김" }, nameOf(s));
  }));
}

function drawRoster(shown) {
  const now = Date.now();
  const online = students.filter((s) => s.last_seen && now - Date.parse(s.last_seen) < ONLINE_MS).length;
  run.roster.replaceChildren(
    h("div", { class: "row between" },
      h("h2", {}, "접속 중 " + online + "명", h("span", { class: "muted small" }, " · 입장 " + students.length + "명")),
      h("button", { class: "ghost", type: "button", onclick() { openModal("입장한 학생", rosterChips(shown, true)); } }, "크게 보기")),
    students.length ? rosterChips(shown) : h("p", { class: "muted small" }, "아직 입장한 학생이 없습니다."),
    students.length ? h("p", { class: "muted small" }, "초록색: 지금 접속 중 · ✓: " + (lesson.slide_count ? "이 쪽" : "") + " 활동에 답함") : h("span", {}));
}

function runBlock(a) {
  if (isInfoActivity(a)) return h("section", { class: "card stack" },
    h("div", { class: "row between" },
      h("div", {}, h("p", { class: "muted small" }, "설명 카드 · " + whereText(a)), h("h2", {}, a.title)),
      h("button", { type: "button", class: a.shared ? "ghost" : "primary", async onclick() { await setActivity(a, { shared: !a.shared }); } }, a.shared ? "공개 끝내기" : "학생에게 공개")),
    h("p", { class: a.shared ? "pill on" : "pill" }, a.shared ? "학생에게 공개 중" : "학생에게는 보이지 않음"),
    linkedDescription(a.questions[0].text));
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
    h("thead", {}, h("tr", {}, h("th", {}, "학번"), h("th", {}, "이름"), a.kind === "quiz" ? h("th", {}, "점수") : null,
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
  }, h("span", { class: "muted small" }, activityName(a) + " · " + whereText(a)), h("span", {}, a.title))) : h("p", { class: "muted small" }, "아직 활동이 없습니다."));
  const kindList = lesson.kind === "survey" ? { survey: "정답 없는 설문", quiz: "정답·자동 채점" } : { slide: "쪽 아래에 붙는 질문", survey: "정답 없는 설문", quiz: "정답·자동 채점" };
  const kinds = h("div", { class: "kinds" }, Object.entries(kindList).map(([k, sub]) =>
    h("button", {
      type: "button", class: "kind",
      onclick() {
        editing = { kind: k, title: "", page: lesson.slide_count ? lesson.page : null, show_answer: true, named: false, shared: false, questions: [newQuestion(k === "survey" ? "long" : "choice")] };
        drawBuild();
      },
    }, h("strong", {}, KIND_NAME[k]), h("span", {}, sub))),
    h("button", { type: "button", class: "kind", onclick() {
      editing = { kind: "survey", title: "", page: lesson.slide_count ? lesson.page : null, show_answer: false, named: false, shared: false,
        questions: [{ id: newId(), type: "info", text: "" }] };
      drawBuild();
    } }, h("strong", {}, "설명 카드"), h("span", {}, "글과 외부 링크만 표시")));
  main.replaceChildren(h("div", { class: "build" },
    h("aside", { class: "stack" },
      h("section", { class: "card stack" }, h("h2", {}, "새로 만들기"), kinds),
      h("section", { class: "card stack" }, h("h2", {}, "이 수업의 활동"), list)),
    editing ? editor() : h("section", { class: "card muted" }, "왼쪽에서 새로 만들거나, 고칠 활동을 고르세요.")));
}

function editor() {
  const e = editing;
  if (isInfoActivity(e)) {
    const msg = h("p", { class: "error" });
    const title = h("input", { type: "text", maxlength: 100, value: e.title, placeholder: "예: 활동 안내", oninput() { e.title = title.value; } });
    const body = h("textarea", { rows: 10, maxlength: 5000, placeholder: "설명과 링크를 입력하세요. https:// 주소는 학생 화면에서 클릭할 수 있습니다.", oninput() { e.questions[0].text = body.value; } }, e.questions[0].text || "");
    return h("section", { class: "card stack editor" },
      h("h2", {}, e.id ? "설명 카드 고치기" : "설명 카드 만들기"),
      h("label", {}, "제목", title), h("label", {}, "설명문", body),
      h("p", { class: "muted small" }, "학생은 이 카드에 답을 입력하지 않습니다."), msg,
      h("div", { class: "row between" },
        e.id ? h("button", { class: "ghost danger", type: "button", async onclick() {
          if (!confirm("설명 카드를 지울까요?")) return;
          const { error } = await sb.from("activities").delete().eq("id", e.id);
          if (error) { msg.textContent = error.message; return; }
          activities = activities.filter((a) => a.id !== e.id); editing = null; drawBuild();
        } }, "카드 지우기") : h("span", {}),
        h("div", { class: "row" },
          h("button", { class: "ghost", type: "button", onclick() { editing = null; drawBuild(); } }, "닫기"),
          h("button", { class: "primary", type: "button", async onclick() {
            e.title = e.title.trim(); e.questions[0].text = e.questions[0].text.trim();
            if (!e.title || !e.questions[0].text) { msg.textContent = "제목과 설명문을 입력하세요."; return; }
            const row = { kind: "survey", title: e.title, page: e.page, show_answer: false, named: false, questions: e.questions };
            if (!e.id) { row.lesson_id = lesson.id; row.sort = activities.length; }
            const saved = await save("activities", row, e.id);
            if (!saved) return;
            const { data } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
            activities = sortActivities(data || []); editing = JSON.parse(JSON.stringify(saved)); drawBuild(); flash("저장했습니다.");
          } }, "저장"))));
  }
  if (e.description === undefined) e.description = activityDescription(e);
  const hasResponses = e.id && responses.some((r) => r.activity_id === e.id);
  const msg = h("p", { class: "error" });
  const redraw = () => { const y = scrollY; drawBuild(); scrollTo(0, y); };

  const title = h("input", { type: "text", maxlength: 100, value: e.title, placeholder: "예: 예상해 보기", oninput() { e.title = title.value; } });
  const description = h("textarea", { rows: 5, maxlength: 2000, placeholder: "설문 전체에 대한 설명을 입력하세요. 웹 주소는 학생 화면에서 링크가 됩니다.", oninput() { e.description = description.value; } }, e.description || "");
  const pageIn = h("input", { type: "number", min: 1, max: Math.max(lesson.slide_count, 1), value: e.page ?? lesson.page, class: "num", "aria-label": "시작 쪽", oninput() { e.page = parseInt(pageIn.value, 10) || 1; } });
  // 여러 쪽에 걸쳐 같은 질문을 띄울 때 끝 쪽. 비우면 시작 쪽 한 쪽에만 보인다
  const pageToIn = h("input", { type: "number", min: 1, max: Math.max(lesson.slide_count, 1), value: e.page_to > e.page ? e.page_to : "", placeholder: "(한 쪽만)", class: "num", "aria-label": "끝 쪽", oninput() { e.page_to = parseInt(pageToIn.value, 10) || null; } });
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
      delete q.description;
      delete q.intro;
      if (!q.text) { msg.textContent = (i + 1) + "번 질문을 입력하세요."; return; }
      if (q.type === "choice" || q.type === "multi") {
        q.options = q.options.map((x) => x.trim()).filter(Boolean);
        if (q.options.length < 2) { msg.textContent = (i + 1) + "번 질문의 보기를 두 개 이상 적으세요."; return; }
        if (new Set(q.options).size !== q.options.length) { msg.textContent = (i + 1) + "번 질문에 같은 보기가 두 번 있습니다."; return; }
      } else { delete q.options; delete q.answer; }
    }
    if (e.questions.length && e.description.trim()) e.questions[0].intro = e.description.trim();
    const row = { kind: e.kind, title: e.title, page: e.page, show_answer: e.show_answer, named: e.named, questions: e.questions };
    // 끝 쪽: 시작 쪽보다 뒤일 때만 쓴다. (page_to 칸이 없는 예전 데이터베이스에서도 한 쪽짜리는 저장되도록 필요할 때만 보낸다)
    const to = e.page != null && e.page_to > e.page ? Math.min(e.page_to, Math.max(lesson.slide_count, e.page)) : null;
    if (to != null || "page_to" in e) row.page_to = to;
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
      lesson.slide_count ? h("label", {}, "어디에 보일까요?", h("div", { class: "row" }, placeSel, e.page != null ? pageIn : null, e.page != null ? h("span", {}, "쪽부터") : null,
        e.page != null ? pageToIn : null, e.page != null ? h("span", {}, "쪽까지") : null)) : null),
      lesson.slide_count && e.page != null ? h("p", { class: "muted small grow" }, "끝 쪽을 적으면 그 사이 쪽마다 같은 질문이 보이고, 학생이 쓴 답도 이어서 보입니다.") : null,
    h("label", {}, "설문 설명문 (선택)", description),
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
      h("thead", {}, h("tr", {}, ["학번", "이름", "저장한 활동", "마지막 저장", "상태", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows))) : h("p", { class: "muted" }, "아직 입장한 학생이 없습니다.")));
}

// ---------- 수업 설정 ----------
function drawSettings() {
  const title = h("input", { type: "text", maxlength: 100, value: lesson ? lesson.title : "", placeholder: "예: 2학년 3반 · 열의 이동" });
  const msg = h("p", { class: "error" });
  let kind = "lesson";
  const kindPick = h("fieldset", { class: "options" }, h("legend", {}, "무엇을 만들까요?"),
    [["lesson", "슬라이드 수업", "PDF 슬라이드를 띄우며 쪽마다 질문"], ["survey", "설문만", "슬라이드 없이 설문·퀴즈 링크 하나"]].map(([k, name, sub]) =>
      h("label", { class: "option" }, h("input", { type: "radio", name: "lesson-kind", checked: k === kind, onchange() { kind = k; } }),
        h("span", {}, h("strong", {}, name), " · ", h("span", { class: "muted small" }, sub)))));

  async function submit(ev) {
    ev.preventDefault();
    const t = title.value.trim();
    if (!t) { msg.textContent = "수업 제목을 입력하세요."; return; }
    if (lesson) {
      const saved = await save("lessons", { title: t }, lesson.id);
      if (!saved) return;
      await loadLessons(saved.id);
      flash("저장했습니다.");
      return;
    }
    const { data, error } = await sb.rpc("create_lesson", { p_title: t, p_kind: kind });
    if (error) { msg.textContent = "만들지 못했습니다: " + error.message; return; }
    tab = "settings";
    if (data.kind === "survey") tab = "build";
    await loadLessons(data.id);
    flash(data.kind === "survey" ? "설문을 만들었습니다. 이제 질문을 넣으세요." : "수업을 만들었습니다. 이제 슬라이드를 올리세요.");
    return;
  }

  async function duplicate() {
    const { data: copy, error } = await sb.rpc("create_lesson", { p_title: (lesson.title + " (복사)").slice(0, 100), p_kind: lesson.kind });
    if (error) return alert("복제하지 못했습니다: " + error.message);
    // 슬라이드 그림은 같은 것을 함께 쓴다(원래 수업을 지워도 다른 수업이 쓰는 그림은 남긴다)
    await sb.from("lessons").update({ slide_dir: lesson.slide_dir, slide_count: lesson.slide_count }).eq("id", copy.id);
    if (activities.length) {
      const r = await sb.from("activities").insert(activities.map((a) => ({
        lesson_id: copy.id, kind: a.kind, title: a.title, page: a.page, show_answer: a.show_answer, named: a.named, questions: a.questions, sort: a.sort,
      })));
      if (r.error) alert("활동을 복사하지 못했습니다: " + r.error.message);
    }
    await loadLessons(copy.id);
    flash("복제했습니다. 제목을 고쳐 주세요.");
  }

  async function remove() {
    const typed = prompt("수업을 지우면 활동, 학생, 응답, 슬라이드가 모두 지워집니다.\n지우려면 수업 코드 「" + lesson.code + "」를 입력하세요.");
    if ((typed || "").trim().toUpperCase() !== lesson.code) return;
    await removeSlideFiles(lesson);
    const { error } = await sb.from("lessons").delete().eq("id", lesson.id);
    if (error) return alert(error.message);
    await loadLessons(null);
  }

  main.replaceChildren(h("div", { class: "stack narrowish" },
    h("form", { class: "card stack", onsubmit: submit },
      h("h2", {}, lesson ? (lesson.kind === "survey" ? "설문 설정" : "수업 설정") : "새로 만들기"),
      lesson ? null : kindPick,
      lesson ? h("p", { class: "join-code" }, "수업 코드 ", h("strong", {}, lesson.code)) : h("p", { class: "muted small" }, "수업 코드는 겹치지 않게 자동으로 만들어집니다."),
      h("label", {}, "제목", title),
      msg,
      h("button", { class: "primary big", type: "submit" }, lesson ? "제목 저장" : "수업 만들기")),
    lesson && lesson.kind !== "survey" ? slidesCard() : null,
    lesson ? h("section", { class: "card stack" },
      h("h2", {}, "학생 접속"),
      h("p", { class: "join-url" }, joinUrl(lesson)),
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick: showJoin }, "QR 크게 보기"),
        h("button", { class: "ghost", type: "button", onclick: duplicate }, "다른 반용으로 복제"),
        h("button", { class: "ghost danger", type: "button", onclick: remove }, "수업 지우기"))) : null));
}

// 슬라이드 올리기: PDF 한 개 또는 그림 여러 장 → 쪽마다 JPG로 바꿔 Storage에 올린다.
function slidesCard() {
  const file = h("input", { type: "file", accept: "application/pdf,image/png,image/jpeg", multiple: true });
  const bar = h("progress", { max: 1, value: 0, hidden: true });
  const status = h("p", { class: "msg" });
  const btn = h("button", { class: "primary", type: "button" }, lesson.slide_count ? "다시 올리기 (기존 슬라이드를 바꿈)" : "올리기");
  btn.addEventListener("click", async () => {
    if (!file.files.length) { status.textContent = "PDF 파일이나 그림 파일을 먼저 고르세요."; return; }
    btn.disabled = true;
    bar.hidden = false;
    try {
      const n = await uploadSlides([...file.files], (done, total, what) => {
        bar.max = total;
        bar.value = done;
        status.textContent = what + " " + done + " / " + total;
      });
      flash("슬라이드 " + n + "장을 올렸습니다.");
      await loadLessons(lesson.id);
    } catch (e) {
      status.textContent = "올리지 못했습니다: " + (e.message || e);
      btn.disabled = false;
    }
  });
  const thumbs = h("div", { class: "thumbs" });
  for (let i = 1; i <= Math.min(lesson.slide_count, 60); i++) thumbs.append(h("img", { src: slideSrc(lesson, i), alt: i + "쪽", loading: "lazy" }));
  return h("section", { class: "card stack" },
    h("h2", {}, "슬라이드 " + (lesson.slide_count ? lesson.slide_count + "장" : "없음")),
    h("p", { class: "muted small" }, "PowerPoint에서 「파일 → 다른 이름으로 저장 → PDF」로 저장한 파일을 올리면 쪽마다 그림으로 바뀝니다. 그림 파일(PNG, JPG) 여러 장을 올려도 됩니다(파일 이름 순서). 100쪽까지."),
    h("div", { class: "row" }, file, btn), bar, status,
    lesson.slide_count ? thumbs : null);
}

async function loadPdfJs() {
  if (!window.pdfjsLib) {
    await new Promise((ok, fail) => document.head.append(h("script", { src: "vendor/pdf.min.js", onload: ok, onerror: () => fail(new Error("PDF 도구를 불러오지 못했습니다")) })));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }
  return window.pdfjsLib;
}

const SLIDE_WIDTH = 1600;

function canvasToJpeg(canvas) {
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("그림으로 바꾸지 못했습니다"))), "image/jpeg", 0.85));
}

// 파일들을 쪽별 JPG 묶음으로 바꾼다
async function toSlideImages(files, progress) {
  const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (pdfs.length > 1) throw new Error("PDF는 한 번에 하나만 올릴 수 있습니다.");
  const out = [];
  if (pdfs.length) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await pdfs[0].arrayBuffer() }).promise;
    if (pdf.numPages > 100) throw new Error("100쪽이 넘습니다(" + pdf.numPages + "쪽).");
    for (let i = 1; i <= pdf.numPages; i++) {
      progress(i - 1, pdf.numPages, "그림으로 바꾸는 중");
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: SLIDE_WIDTH / page.getViewport({ scale: 1 }).width });
      const canvas = h("canvas", { width: Math.round(vp.width), height: Math.round(vp.height) });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push(await canvasToJpeg(canvas));
    }
    return out;
  }
  const imgs = files.filter((f) => /^image\/(png|jpeg)$/.test(f.type)).sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
  if (!imgs.length) throw new Error("PDF나 PNG·JPG 파일을 고르세요.");
  if (imgs.length > 100) throw new Error("100장이 넘습니다.");
  for (const [i, f] of imgs.entries()) {
    progress(i, imgs.length, "그림 줄이는 중");
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, SLIDE_WIDTH / bmp.width);
    const canvas = h("canvas", { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    out.push(await canvasToJpeg(canvas));
  }
  return out;
}

const slideFolder = (l) => me.id + "/" + l.id + "/";

async function uploadSlides(files, progress) {
  const images = await toSlideImages(files, progress);
  const folder = slideFolder(lesson);
  for (const [i, blob] of images.entries()) {
    progress(i, images.length, "올리는 중");
    const { error } = await sb.storage.from("slides").upload(folder + (i + 1) + ".jpg", blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
    if (error) throw error;
  }
  progress(images.length, images.length, "올리는 중");
  // 전보다 쪽 수가 줄었으면 남은 그림을 지운다
  const { data: old } = await sb.storage.from("slides").list(folder.replace(/\/$/, ""), { limit: 1000 });
  const extra = (old || []).map((o) => o.name).filter((n) => parseInt(n, 10) > images.length).map((n) => folder + n);
  if (extra.length) await sb.storage.from("slides").remove(extra);
  const dir = SB_URL + "/storage/v1/object/public/slides/" + folder + "{n}.jpg?v=" + Date.now();
  const { error } = await sb.from("lessons").update({ slide_dir: dir, slide_count: images.length, page: 1 }).eq("id", lesson.id);
  if (error) throw error;
  return images.length;
}

// 수업을 지울 때 그 수업의 슬라이드 그림도 지운다(복제한 다른 수업이 같은 그림을 쓰면 남긴다)
async function removeSlideFiles(l) {
  if (!l.slide_count || !l.slide_dir.includes("/" + l.id + "/")) return;
  if (lessons.some((x) => x.id !== l.id && x.slide_dir.split("?")[0] === l.slide_dir.split("?")[0])) return;
  // 그림을 올린 교사의 폴더(교사가 여러 명일 수 있으므로 주소에서 읽는다)
  const m = /\/public\/slides\/(.+\/)\{n\}/.exec(l.slide_dir);
  if (!m) return;
  const folder = decodeURIComponent(m[1]);
  const { data } = await sb.storage.from("slides").list(folder.replace(/\/$/, ""), { limit: 1000 });
  if (data && data.length) await sb.storage.from("slides").remove(data.map((o) => folder + o.name));
}

// ---------- CSV ----------
function downloadCSV(acts, fileName) {
  const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const head = ["학번", "이름"];
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
