// Mirrors open merge requests into a bookmarks folder:
//   <folder>/To review, <folder>/My MRs
// Only bookmarks pointing at merge requests are managed; anything else the
// user puts in these folders is left alone.

const MR_URL = /\/-\/merge_requests\/\d+/;

const BOOKMARK_PARENTS = {
  toolbar_____: "Bookmarks Toolbar",
  menu________: "Bookmarks Menu",
  unfiled_____: "Other Bookmarks",
};

function bookmarkTitle(mr, withStatus) {
  const shortRef = `${mr.project.split("/").pop()}!${mr.iid}`;
  let icon = "";
  if (withStatus) {
    if (mr.draft) icon = "📝";
    else if (mr.pipeline === "failed") icon = "❌";
    else if (mr.mergeStatus === "conflict" || mr.mergeStatus === "need_rebase") icon = "⚠️";
    else if (mr.mergeStatus === "mergeable") icon = "✅";
    else if (mr.pipeline === "running" || mr.pipeline === "pending") icon = "⏳";
  }
  return `${icon ? `${icon} ` : ""}${mr.title} · ${shortRef}`;
}

async function ensureFolder(ids, slot, parentId, title) {
  if (ids[slot]) {
    try {
      const [node] = await browser.bookmarks.get(ids[slot]);
      if (node.type === "folder") {
        if (node.parentId !== parentId) await browser.bookmarks.move(node.id, { parentId });
        if (node.title !== title) await browser.bookmarks.update(node.id, { title });
        return node.id;
      }
    } catch {
      // Deleted by the user; recreate below.
    }
  }
  // Reuse a same-named folder (e.g. after storage was cleared) before creating one.
  const siblings = await browser.bookmarks.getChildren(parentId);
  const existing = siblings.find((n) => n.type === "folder" && n.title === title);
  const id = existing?.id ?? (await browser.bookmarks.create({ parentId, title, type: "folder" })).id;
  ids[slot] = id;
  return id;
}

async function reconcileFolder(folderId, wanted) {
  const wantedUrls = new Set(wanted.map((w) => w.url));
  const managed = new Map();
  for (const node of await browser.bookmarks.getChildren(folderId)) {
    if (node.type !== "bookmark" || !MR_URL.test(node.url)) continue;
    if (!wantedUrls.has(node.url) || managed.has(node.url)) {
      await browser.bookmarks.remove(node.id); // merged/closed, or a duplicate
    } else {
      managed.set(node.url, node);
    }
  }

  for (const [index, w] of wanted.entries()) {
    const node = managed.get(w.url);
    if (!node) {
      await browser.bookmarks.create({ parentId: folderId, title: w.title, url: w.url, index });
    } else if (node.title !== w.title) {
      await browser.bookmarks.update(node.id, { title: w.title });
    }
  }

  // Keep MR bookmarks in the same order as the panel (most recently updated first).
  const current = (await browser.bookmarks.getChildren(folderId)).filter(
    (n) => n.type === "bookmark" && wantedUrls.has(n.url),
  );
  if (current.some((n, i) => n.url !== wanted[i].url)) {
    const byUrl = new Map(current.map((n) => [n.url, n]));
    for (const [index, w] of wanted.entries()) {
      await browser.bookmarks.move(byUrl.get(w.url).id, { parentId: folderId, index });
    }
  }
}

async function syncBookmarks(cache, config) {
  if (!config.bookmarks) return;
  if (!(await browser.permissions.contains({ permissions: ["bookmarks"] }))) return;

  const { bookmarkIds = {} } = await browser.storage.local.get("bookmarkIds");
  const ids = { ...bookmarkIds };
  const parent = config.bookmarkParent in BOOKMARK_PARENTS ? config.bookmarkParent : "toolbar_____";
  const rootId = await ensureFolder(ids, "root", parent, config.bookmarkFolder || DEFAULT_CONFIG.bookmarkFolder);

  const authoredUrls = new Set(cache.mrs.authored.map((m) => m.url));
  const mine = [...cache.mrs.authored, ...cache.mrs.assigned.filter((m) => !authoredUrls.has(m.url))]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const groups = [
    { slot: "review", title: "To review", items: cache.mrs.review },
    { slot: "mine", title: "My MRs", items: mine },
  ];
  for (const g of groups) {
    const folderId = await ensureFolder(ids, g.slot, rootId, g.title);
    await reconcileFolder(folderId, g.items.map((mr) => ({
      url: mr.url,
      title: bookmarkTitle(mr, config.bookmarkStatus),
    })));
  }

  await browser.storage.local.set({ bookmarkIds: ids });
}
