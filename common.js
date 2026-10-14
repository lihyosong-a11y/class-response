// 학생 화면과 교사 화면이 함께 쓰는 것들

const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL);
const sb = configured ? supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const KIND_NAME = { slide: "슬라이드 질문", survey: "설문", quiz: "퀴즈" };
const TYPE_NAME = { choice: "하나 고르기", multi: "여러 개 고르기", short: "짧은 글", long: "긴 글" };

// 화면 요소 만들기. 학생이 쓴 글은 늘 글자(텍스트)로만 넣는다(innerHTML을 쓰지 않음).
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// 슬라이드 그림 주소. 보통은 "폴더/1.png". 폴더 칸에 {n}을 넣으면 그 자리에 쪽 번호가 들어간다
// (예: "slides/슬라이드{n}.PNG" → PowerPoint가 내보낸 이름을 그대로 쓸 때).
function slideSrc(lesson, n) {
  const dir = lesson.slide_dir.trim();
  return encodeURI(dir.includes("{n}") ? dir.split("{n}").join(n) : dir.replace(/\/+$/, "") + "/" + n + ".png");
}

function fmtTime(t) {
  if (!t) return "—";
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? "" : (d.getMonth() + 1) + "/" + d.getDate() + " ") +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// 응답 하나를 글로: 여러 개 고르기는 쉼표로 잇는다
function answerText(v) {
  if (Array.isArray(v)) return v.join(", ");
  return v == null ? "" : String(v);
}

function isEmptyAnswer(v) {
  return v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
}

// 응답 모아 보기: 고르는 질문은 막대, 글은 목록. docs = [{ name, answers }]
function summaryView(questions, docs, opts) {
  opts = opts || {};
  return questions.map((q, i) => {
    const answered = docs.filter((d) => !isEmptyAnswer(d.answers[q.id]));
    const head = h("p", { class: "sum-q" }, (i + 1) + ". " + q.text);
    if (q.type === "choice" || q.type === "multi") {
      return h("div", { class: "sum-block" }, head, q.options.map((o) => {
        const n = answered.filter((d) => [].concat(d.answers[q.id]).includes(o)).length;
        const pct = answered.length ? Math.round((n / answered.length) * 100) : 0;
        const right = q.answer != null && [].concat(q.answer).includes(o);
        return h("div", { class: "bar-row" },
          h("span", { class: "bar-label" }, o, right ? h("strong", { class: "right-mark" }, " ✓정답") : null),
          h("span", { class: "bar-track" }, h("span", { class: "bar", style: "width:" + pct + "%" })),
          h("span", { class: "bar-value" }, n + "명"));
      }));
    }
    return h("div", { class: "sum-block" }, head,
      answered.length ? answered.map((d) => h("p", { class: "note" }, d.name ? h("strong", {}, d.name + " · ") : null, answerText(d.answers[q.id])))
        : h("p", { class: "muted small" }, opts.empty || "아직 응답이 없습니다."));
  });
}

function openModal(title, body) {
  const close = () => box.remove();
  const box = h("div", { class: "overlay", onclick(e) { if (e.target === box) close(); } },
    h("div", { class: "modal" },
      h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "ghost", type: "button", onclick: close }, "닫기")),
      h("div", { class: "modal-body" }, body)));
  document.body.append(box);
  return close;
}

function notConfigured(app) {
  app.replaceChildren(h("main", { class: "narrow" }, h("section", { class: "card" },
    h("h1", {}, "아직 연결되지 않았습니다"),
    h("p", {}, "config.js 파일에 Supabase 주소(SUPABASE_URL)와 publishable 키(SUPABASE_KEY)를 넣어 주세요. 방법은 README.md에 있습니다."))));
}
