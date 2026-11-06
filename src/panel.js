// Sidebar / popup UI. Reads the cache written by the background script and
// re-renders whenever storage changes.

const ICONS = {
  mr: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="12.5" r="1.8"/><path d="M4 5.3v5.4M12 10.7V7a2.5 2.5 0 0 0-2.5-2.5H7.5M9 3 7.5 4.5 9 6"/></svg>',
  issue: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/></svg>',
  task: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="m5.5 8 1.8 1.8L10.5 6.3"/></svg>',
  incident: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.5v.1"/></svg>',
  comment: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 8.5 3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  success: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m5 8.2 2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  failed: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m5.7 5.7 4.6 4.6m0-4.6-4.6 4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  running: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3"/><path d="M8 1.5A6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  pending: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.2 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  canceled: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m3.5 12.5 9-9" stroke="currentColor" stroke-width="1.5"/></svg>',
};

const PIPELINE_ICON = {
  success: "success",
  failed: "failed",
  running: "running",
  preparing: "running",
  canceled: "canceled",
  skipped: "canceled",
};

const MERGE_STATUS = {
  mergeable: ["Ready to merge", "green"],
  conflict: ["Conflicts", "red"],
  need_rebase: ["Needs rebase", "amber"],
  discussions_not_resolved: ["Unresolved threads", "amber"],
  not_approved: ["Needs approval", "amber"],
  requested_changes: ["Changes requested", "red"],
  blocked_status: ["Blocked", "red"],
  jira_association_missing: ["Missing Jira issue", "amber"],
  security_policy_violations: ["Policy violation", "red"],
};

const TODO_ACTION = {
  assigned: "assigned you",
  mentioned: "mentioned you",
  directly_addressed: "addressed you",
  build_failed: "pipeline failed",
  marked: "added a to-do",
  approval_required: "needs your approval",
  unmergeable: "can't be merged",
  review_requested: "requested your review",
  review_submitted: "reviewed",
  merge_train_removed: "removed from merge train",
  member_access_requested: "requested access",
};

const TABS = [
  { id: "inbox", label: "Inbox" },
  { id: "review", label: "Review" },
  { id: "mine", label: "My MRs" },
  { id: "issues", label: "Issues" },
];

const REVIEWED_STATES = new Set(["approved", "requested_changes", "reviewed"]);

const state = { cache: null, seen: {}, syncing: false, tab: "inbox", filter: "", allowWrite: false };
const $ = (sel) => document.querySelector(sel);

const isPopup = (() => {
  try {
    return browser.extension.getViews({ type: "popup" }).includes(window);
  } catch {
    return false;
  }
})();
if (isPopup) document.body.classList.add("popup");

// ---------- helpers ----------

const iconCache = new Map();
function svgIcon(name) {
  if (!iconCache.has(name)) {
    const src = ICONS[name].replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
    const doc = new DOMParser().parseFromString(src, "image/svg+xml");
    iconCache.set(name, doc.documentElement);
  }
  return document.importNode(iconCache.get(name), true);
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "icon") el.append(svgIcon(v));
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// The extension has no access to the GitLab host other than the API with the
// token, and avatar uploads are not served through the API. So avatars hosted
// on the instance are never requested; those show initials. Avatars hosted
// elsewhere (e.g. Gravatar) are loaded and shown once they arrive.

const avatarSrc = new Map(); // url -> loaded, for flicker-free re-renders

function initials(user) {
  const name = user?.name || user?.username || "?";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
}

function hue(text = "") {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

function isExternalAvatar(url) {
  const base = state.cache?.baseUrl;
  if (!url || !base) return false;
  try {
    return new URL(url).origin !== new URL(base).origin;
  } catch {
    return false;
  }
}

function avatar(user, cls = "") {
  const el = h("span", { class: `avatar ${cls}`, title: user?.name, "aria-hidden": "true" }, initials(user));
  el.style.backgroundColor = `hsl(${hue(user?.username)} 40% 52%)`;
  const url = user?.avatar;
  if (!isExternalAvatar(url)) return el;
  const show = () => {
    avatarSrc.set(url, true);
    el.style.backgroundImage = `url("${url}")`;
    el.textContent = "";
  };
  if (avatarSrc.has(url)) {
    show();
  } else {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = show;
    img.src = url;
  }
  return el;
}

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400 / 7)}w`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isUnread(item) {
  return item.updatedAt && state.seen[item.key] !== item.updatedAt;
}

async function markSeen(items) {
  const seen = { ...state.seen };
  for (const i of items) if (i.updatedAt) seen[i.key] = i.updatedAt;
  state.seen = seen;
  await browser.storage.local.set({ seen });
}

function matches(item) {
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    item.title, item.ref, item.author?.name, item.author?.username,
    item.sourceBranch, item.targetBranch, ...(item.labels || []),
  ].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function send(msg) {
  return browser.runtime.sendMessage(msg);
}

function openItem(e, item) {
  markSeen([item]);
  if (e.type === "auxclick" || e.ctrlKey || e.metaKey || e.shiftKey) return; // let the browser handle it
  e.preventDefault();
  send({ type: "open", url: item.url });
  if (isPopup) window.close();
}

// ---------- data per tab ----------

function myReviewState(mr) {
  const me = state.cache?.user?.username;
  return mr.reviewers.find((r) => r.username === me)?.state ?? null;
}

function sectionsFor(tab) {
  const c = state.cache;
  if (!c?.mrs) return [];
  switch (tab) {
    case "inbox":
      return [{ items: c.todos, render: todoRow }];
    case "review": {
      const waiting = c.mrs.review.filter((m) => !REVIEWED_STATES.has(myReviewState(m)));
      const done = c.mrs.review.filter((m) => REVIEWED_STATES.has(myReviewState(m)));
      return [
        { title: "Waiting on you", items: waiting, render: mrRow },
        { title: "Already reviewed", items: done, render: (m) => mrRow(m, { dim: true }) },
      ];
    }
    case "mine": {
      const authored = new Set(c.mrs.authored.map((m) => m.key));
      return [
        { title: "Authored", items: c.mrs.authored, render: mrRow },
        { title: "Assigned to you", items: c.mrs.assigned.filter((m) => !authored.has(m.key)), render: mrRow },
      ];
    }
    case "issues":
      return [
        { title: "Assigned to you", items: c.issues.filter((i) => i.assignedToMe), render: issueRow },
        { title: "Created by you", items: c.issues.filter((i) => !i.assignedToMe), render: issueRow },
      ];
  }
  return [];
}

function tabItems(tab) {
  return sectionsFor(tab).flatMap((s) => s.items);
}

// ---------- rows ----------

function mrRow(mr, { dim = false } = {}) {
  const pipe = mr.pipeline ?? "none";
  const status = MERGE_STATUS[mr.mergeStatus];
  const lead = mr.pipeline
    ? h("span", { class: `lead pipe-${pipe}`, title: `Pipeline: ${pipe}`, icon: PIPELINE_ICON[pipe] ?? "pending" })
    : h("span", { class: "lead pipe-none", title: "No pipeline", icon: "mr" });

  const reviewers = mr.reviewers.length
    ? h("span", { class: "reviewers" }, mr.reviewers.slice(0, 5).map((r) => {
        const el = avatar(r, r.state ?? "");
        el.title = `${r.name}${r.state ? ` — ${r.state.replaceAll("_", " ")}` : ""}`;
        return el;
      }))
    : null;

  return h("a", {
    class: `row ${isUnread(mr) ? "unread" : ""} ${dim ? "dim" : ""}`,
    href: mr.url,
    onclick: (e) => openItem(e, mr),
    onauxclick: (e) => openItem(e, mr),
  },
    lead,
    h("div", { class: "body" },
      h("div", { class: "title", title: mr.title }, mr.title),
      h("div", { class: "meta" },
        h("span", { class: "ref" }, mr.ref),
        state.tab !== "mine" && mr.author ? h("span", null, mr.author.name) : null,
        mr.draft ? h("span", { class: "chip" }, "Draft") : null,
        status ? h("span", { class: `chip ${status[1]}` }, status[0]) : null,
        mr.approved && mr.mergeStatus !== "mergeable" ? h("span", { class: "chip green" }, "Approved") : null,
        mr.notes ? h("span", { class: "notes", title: `${mr.notes} comments` }, h("span", { icon: "comment" }), mr.notes) : null,
        reviewers,
      ),
    ),
    h("div", { class: "side" }, h("span", { title: new Date(mr.updatedAt).toLocaleString() }, ago(mr.updatedAt))),
  );
}

function issueRow(issue) {
  const icon = issue.type === "task" ? "task" : issue.type === "incident" ? "incident" : "issue";
  const overdue = issue.dueDate && new Date(issue.dueDate) < new Date(new Date().toDateString());
  return h("a", {
    class: `row ${isUnread(issue) ? "unread" : ""}`,
    href: issue.url,
    onclick: (e) => openItem(e, issue),
    onauxclick: (e) => openItem(e, issue),
  },
    h("span", { class: "lead pipe-none", title: issue.type, icon }),
    h("div", { class: "body" },
      h("div", { class: "title", title: issue.title }, issue.confidential ? "🔒 " : "", issue.title),
      h("div", { class: "meta" },
        h("span", { class: "ref" }, issue.ref),
        issue.dueDate ? h("span", { class: `chip ${overdue ? "red" : ""}` }, `Due ${issue.dueDate}`) : null,
        issue.labels.slice(0, 3).map((l) => h("span", { class: "chip" }, l)),
        issue.labels.length > 3 ? h("span", { class: "chip" }, `+${issue.labels.length - 3}`) : null,
        issue.notes ? h("span", { class: "notes" }, h("span", { icon: "comment" }), issue.notes) : null,
      ),
    ),
    h("div", { class: "side" }, h("span", { title: new Date(issue.updatedAt).toLocaleString() }, ago(issue.updatedAt))),
  );
}

function todoRow(todo) {
  const action = TODO_ACTION[todo.action] ?? todo.action.replaceAll("_", " ");
  const showBody = todo.body && todo.body !== todo.title && ["mentioned", "directly_addressed", "marked"].includes(todo.action);
  const doneBtn = h("button", {
    class: "done-btn",
    title: "Mark as done",
    "aria-label": "Mark as done",
    icon: "check",
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      doneBtn.disabled = true;
      const res = await send({ type: "todoDone", id: todo.id });
      if (!res?.ok) {
        doneBtn.disabled = false;
        showBanner(res?.error ?? "Could not mark as done.");
      }
    },
  });

  return h("a", {
    class: "row",
    href: todo.url,
    onclick: (e) => openItem(e, todo),
    onauxclick: (e) => openItem(e, todo),
  },
    h("span", { class: "lead" }, avatar(todo.author)),
    h("div", { class: "body" },
      h("div", { class: "meta", style: "margin: 0 0 2px" }, h("span", null, h("b", null, todo.author?.name ?? "GitLab"), " ", action)),
      h("div", { class: "title", title: todo.title }, todo.title),
      h("div", { class: "meta" }, h("span", { class: "ref" }, todo.ref)),
      showBody ? h("div", { class: "note", title: todo.body }, todo.body) : null,
    ),
    h("div", { class: "side" }, h("span", { title: new Date(todo.createdAt).toLocaleString() }, ago(todo.createdAt)), state.allowWrite ? doneBtn : null),
  );
}

// ---------- rendering ----------

function renderHeader() {
  const c = state.cache;
  if (c?.user) {
    $("#username").textContent = c.user.name;
    const el = avatar(c.user, "lg");
    el.id = "avatar";
    $("#avatar").replaceWith(el);
  }
  let status = "Not synced yet";
  if (state.syncing) status = "Syncing…";
  else if (c?.syncedAt) {
    const when = ago(new Date(c.syncedAt).toISOString());
    status = [
      c.user && `@${c.user.username}`,
      new URL(c.baseUrl).host,
      when === "now" ? "synced just now" : `synced ${when} ago`,
    ].filter(Boolean).join(" · ");
  }
  $("#status").textContent = status;
  $("#refresh").classList.toggle("spinning", state.syncing);
}

function renderTabs() {
  const nav = $("#tabs");
  nav.replaceChildren(...TABS.map((t, i) => {
    const items = tabItems(t.id);
    const hot = t.id === "inbox" ? items.length > 0 : items.some(isUnread);
    const count = t.id === "review"
      ? sectionsFor("review")[0]?.items.length ?? 0
      : items.length;
    return h("button", {
      class: "tab",
      role: "tab",
      "aria-selected": String(state.tab === t.id),
      title: `${t.label} (${i + 1})`,
      onclick: () => selectTab(t.id),
    }, t.label, h("span", { class: `count ${hot && count ? "hot" : ""}` }, count));
  }));
}

function renderBulk() {
  const btn = $("#bulk");
  if (state.tab === "inbox") {
    btn.hidden = !state.allowWrite || !state.cache?.todos?.length;
    btn.textContent = "Mark all done";
  } else {
    btn.hidden = !tabItems(state.tab).some(isUnread);
    btn.textContent = "Mark all read";
  }
}

function renderList() {
  const list = $("#list");
  const c = state.cache;

  if (!c?.mrs) {
    list.replaceChildren(h("div", { class: "empty" },
      h("strong", null, c?.error ? "Couldn't load GitLab data" : "Loading…"),
      c?.error ? "See the message above." : "",
    ));
    return;
  }

  const out = [];
  for (const sec of sectionsFor(state.tab)) {
    const items = sec.items.filter(matches);
    if (!items.length) continue;
    if (sec.title) out.push(h("div", { class: "section" }, `${sec.title} · ${items.length}`));
    out.push(...items.map((i) => sec.render(i)));
  }

  if (!out.length) {
    const msg = state.filter
      ? ["No matches", "Try a different filter."]
      : {
          inbox: ["Inbox zero", "No pending to-dos."],
          review: ["Nothing to review", "No open merge requests are waiting on you."],
          mine: ["No open merge requests", "MRs you author or are assigned show up here."],
          issues: ["No open issues", "Issues assigned to or created by you show up here."],
        }[state.tab];
    out.push(h("div", { class: "empty" }, h("strong", null, msg[0]), msg[1]));
  }
  list.replaceChildren(...out);
}

function showBanner(message, action) {
  const b = $("#banner");
  if (!message) {
    b.hidden = true;
    return;
  }
  b.replaceChildren(message, action ? h("button", { onclick: action.run }, action.label) : "");
  b.hidden = false;
}

function renderBanner() {
  const err = state.cache?.error;
  if (!err) return showBanner(null);
  const needsSettings = err.kind === "config" || err.status === 401 || err.status === 403 || err.status === 0;
  showBanner(err.message, needsSettings
    ? { label: "Open settings", run: () => browser.runtime.openOptionsPage() }
    : { label: "Retry", run: refresh });
}

function render() {
  renderHeader();
  renderTabs();
  renderBulk();
  renderBanner();
  renderList();
}

// ---------- actions ----------

function selectTab(id) {
  state.tab = id;
  browser.storage.local.set({ ui: { tab: id } });
  $("#list").scrollTop = 0;
  render();
}

function refresh() {
  state.syncing = true;
  renderHeader();
  send({ type: "sync" });
}

$("#refresh").addEventListener("click", refresh);
$("#settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  if (isPopup) window.close();
});

$("#filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});

$("#bulk").addEventListener("click", async () => {
  if (state.tab === "inbox") {
    if (!confirm(`Mark all ${state.cache.todos.length} to-dos as done?`)) return;
    const res = await send({ type: "todosAllDone" });
    if (!res?.ok) showBanner(res?.error ?? "Could not mark to-dos as done.");
  } else {
    await markSeen(tabItems(state.tab));
    render();
  }
});

document.addEventListener("keydown", (e) => {
  const typing = e.target.matches("input, textarea");
  if (e.key === "Escape" && typing) {
    e.target.value = "";
    state.filter = "";
    e.target.blur();
    renderList();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    $("#filter").focus();
  } else if (e.key === "r") {
    refresh();
  } else if (/^[1-9]$/.test(e.key) && TABS[e.key - 1]) {
    selectTab(TABS[e.key - 1].id);
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.cache) state.cache = changes.cache.newValue;
  if (changes.seen) state.seen = changes.seen.newValue ?? {};
  if (changes.syncing) state.syncing = !!changes.syncing.newValue;
  if (changes.config) state.allowWrite = !!changes.config.newValue?.allowWrite;
  if (changes.cache || changes.seen || changes.syncing || changes.config) render();
});

// Keep relative times fresh.
setInterval(render, 60_000);

(async () => {
  const { cache, seen, ui, syncing } = await browser.storage.local.get(["cache", "seen", "ui", "syncing"]);
  const { allowWrite } = await getConfig();
  Object.assign(state, { cache, seen: seen ?? {}, syncing: !!syncing, tab: ui?.tab ?? "inbox", allowWrite });
  render();
  // Refresh on open if data is more than a minute old.
  if (!cache?.syncedAt || Date.now() - cache.syncedAt > 60_000) refresh();
})();
