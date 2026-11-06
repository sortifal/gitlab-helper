// Background event page: periodic sync, badge, desktop notifications.
//
// Security model: the extension has no host permissions. It reaches GitLab
// only through the API's CORS (Access-Control-Allow-Origin: *, without
// credentials), so the browser never lets it use the GitLab session, cookies
// or site storage; the configured access token is the only credential.

const ALARM = "gitlab-sync";
let inflight = null;

async function schedule() {
  const config = await getConfig();
  await browser.alarms.clear(ALARM);
  if (config.token) {
    const period = Math.max(1, Number(config.pollMinutes) || DEFAULT_CONFIG.pollMinutes);
    browser.alarms.create(ALARM, { periodInMinutes: period });
  }
}

function sync() {
  inflight ??= doSync().finally(() => (inflight = null));
  return inflight;
}

async function doSync() {
  const config = await getConfig();
  const { cache: prev = {} } = await browser.storage.local.get("cache");

  if (!config.token) {
    await browser.storage.local.set({
      cache: { ...prev, error: { kind: "config", message: "Add your GitLab URL and access token in settings." } },
    });
    setBadge("!", "#888");
    return;
  }

  await browser.storage.local.set({ syncing: true });
  try {
    const client = new GitLabClient(config.baseUrl, config.token);
    const [mrs, todos, issues] = await Promise.all([
      client.fetchMergeRequests(),
      client.fetchTodos(),
      client.fetchIssues(),
    ]);
    const cache = {
      baseUrl: client.base,
      user: mrs.user,
      mrs: { authored: mrs.authored, review: mrs.review, assigned: mrs.assigned },
      todos,
      issues,
      syncedAt: Date.now(),
      error: null,
    };
    // Only notify when the previous sync was for the same instance.
    if (config.notify && prev.todos && prev.baseUrl === cache.baseUrl) {
      notifyNewTodos(todos, prev.todos, cache.baseUrl);
    }
    await updateSeen(cache, prev.baseUrl !== cache.baseUrl);
    await browser.storage.local.set({ cache });
    updateBadge(cache);
    // Bookmark problems shouldn't surface as a GitLab sync error.
    await syncBookmarks(cache, config).catch((e) => console.error("Bookmark sync failed:", e));
  } catch (e) {
    const message = e instanceof GitLabError ? e.friendly : String(e?.message ?? e);
    await browser.storage.local.set({ cache: { ...prev, error: { status: e.status, message } } });
    setBadge("!", "#c0392b");
  } finally {
    await browser.storage.local.set({ syncing: false });
  }
}

function allItems(cache) {
  return [...cache.mrs.authored, ...cache.mrs.review, ...cache.mrs.assigned, ...cache.issues];
}

// "seen" maps item key -> updatedAt the user last looked at. The first sync
// marks everything as seen; afterwards new/updated items show as unread.
// Keys for items that vanished are pruned.
async function updateSeen(cache, reset) {
  const seen = reset ? null : (await browser.storage.local.get("seen")).seen;
  const next = {};
  for (const item of allItems(cache)) {
    if (!seen) next[item.key] = item.updatedAt;
    else if (item.key in seen) next[item.key] = seen[item.key];
  }
  await browser.storage.local.set({ seen: next });
}

function setBadge(text, color) {
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color });
}

function updateBadge(cache) {
  const n = cache.todos.length;
  setBadge(n ? String(n > 99 ? "99+" : n) : "", "#fc6d26");
  browser.action.setTitle({
    title: n ? `GitLab Helper — ${n} pending to-do${n === 1 ? "" : "s"}` : "GitLab Helper",
  });
}

const ACTION_TEXT = {
  assigned: "assigned you",
  mentioned: "mentioned you",
  directly_addressed: "addressed you",
  build_failed: "pipeline failed",
  marked: "added a to-do",
  approval_required: "needs your approval",
  unmergeable: "can't be merged",
  review_requested: "requested your review",
  review_submitted: "reviewed your merge request",
  merge_train_removed: "removed from merge train",
  member_access_requested: "requested access",
};

function notifyNewTodos(todos, prevTodos, baseUrl) {
  const known = new Set(prevTodos.map((t) => t.id));
  const fresh = todos.filter((t) => !known.has(t.id));
  if (!fresh.length) return;
  const icon = browser.runtime.getURL("icons/icon-96.png");

  if (fresh.length > 3) {
    browser.notifications.create(`url:${baseUrl}/dashboard/todos`, {
      type: "basic",
      iconUrl: icon,
      title: `${fresh.length} new GitLab to-dos`,
      message: fresh.slice(0, 3).map((t) => `• ${t.title}`).join("\n") + "\n…",
    });
    return;
  }
  for (const t of fresh) {
    const who = t.author?.name ?? "Someone";
    const what = ACTION_TEXT[t.action] ?? t.action.replaceAll("_", " ");
    browser.notifications.create(`url:${t.url}`, {
      type: "basic",
      iconUrl: icon,
      title: `${who} ${what}`,
      message: `${t.title}\n${t.ref}`,
    });
  }
}

// Without host access the extension can't see which tabs are open on GitLab,
// so it always opens a new tab.
async function openUrl(url) {
  await browser.tabs.create({ url });
}

// Runs a write action against GitLab, only if the user enabled writes.
async function withWriteClient(fn) {
  const config = await getConfig();
  if (!config.allowWrite) return { ok: false, error: "Write actions are disabled in settings." };
  const client = new GitLabClient(config.baseUrl, config.token);
  try {
    await fn(client);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof GitLabError ? e.friendly : String(e) };
  }
}

async function removeTodos(predicate) {
  const { cache } = await browser.storage.local.get("cache");
  if (!cache?.todos) return;
  cache.todos = cache.todos.filter((t) => !predicate(t));
  await browser.storage.local.set({ cache });
  updateBadge(cache);
}

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case "sync":
      return sync().then(() => ({ ok: true }));
    case "open":
      return openUrl(msg.url).then(() => ({ ok: true }));
    case "todoDone":
      return withWriteClient(async (c) => {
        await c.markTodoDone(msg.id);
        await removeTodos((t) => t.id === msg.id);
      });
    case "todosAllDone":
      return withWriteClient(async (c) => {
        await c.markAllTodosDone();
        await removeTodos(() => true);
      });
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) sync();
});

browser.notifications.onClicked.addListener((id) => {
  if (id.startsWith("url:")) openUrl(id.slice(4));
  browser.notifications.clear(id);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config) {
    schedule().then(sync);
  }
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  const config = await getConfig();
  if (reason === "install" && !config.token) browser.runtime.openOptionsPage();
  if (reason === "update") {
    // Earlier versions held host access to the GitLab instance and cached
    // avatars fetched with the browser session; drop both.
    await browser.storage.local.remove("avatars");
    const { origins = [] } = await browser.permissions.getAll();
    if (origins.length) await browser.permissions.remove({ origins }).catch(() => {});
  }
});

browser.runtime.onStartup.addListener(() => sync());

// Event pages can be restarted at any time; make sure the alarm exists.
browser.alarms.get(ALARM).then((a) => {
  if (!a) schedule().then(sync);
});
