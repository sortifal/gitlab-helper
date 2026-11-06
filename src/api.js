// Shared GitLab API client + data normalization.
// Loaded by the background script and by the options page.

const DEFAULT_CONFIG = {
  baseUrl: "https://gitlab.com",
  token: "",
  pollMinutes: 3,
  notify: true,
  allowWrite: false,
  bookmarks: false,
  bookmarkFolder: "GitLab MRs",
  bookmarkParent: "toolbar_____",
  bookmarkStatus: true,
};

async function getConfig() {
  const { config } = await browser.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...config };
}

function normalizeBaseUrl(url) {
  const u = new URL(url.trim());
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

class GitLabError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }

  get friendly() {
    if (this.status === 401) return "Access token is invalid or expired.";
    if (this.status === 403) return "Access token lacks the required scope (needs read_api, or api to mark to-dos done).";
    if (this.status === 0) {
      // Firefox reports TLS failures, DNS errors and missing host permissions
      // all as a generic NetworkError, so list the likely causes.
      return `Cannot reach GitLab (${this.message}). If the instance uses a self-signed or internal-CA ` +
        "certificate, trust the CA in Firefox; also check the VPN, and that the instance allows " +
        "cross-origin API requests (GitLab does by default).";
    }
    return this.message;
  }
}

class GitLabClient {
  constructor(baseUrl, token) {
    this.base = normalizeBaseUrl(baseUrl);
    this.token = token;
  }

  absolute(url) {
    if (!url) return null;
    return url.startsWith("http") ? url : this.base + url;
  }

  async #fetch(url, init) {
    let res;
    try {
      // credentials: omit -> never mix in the browser session cookie.
      res = await fetch(url, { ...init, credentials: "omit" });
    } catch (e) {
      throw new GitLabError(0, e.message);
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.message || body.error_description || body.error || detail;
        if (typeof detail === "object") detail = JSON.stringify(detail);
      } catch {}
      throw new GitLabError(res.status, `${res.status} ${detail}`);
    }
    return res.status === 204 ? null : res.json();
  }

  rest(path, { method = "GET", params } = {}) {
    const url = new URL(`${this.base}/api/v4${path}`);
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null) url.searchParams.set(k, v);
    }
    return this.#fetch(url, { method, headers: { "PRIVATE-TOKEN": this.token } });
  }

  async graphql(query, variables = {}) {
    const json = await this.#fetch(`${this.base}/api/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (json.errors?.length) {
      throw new GitLabError(200, json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }

  // ---------- Merge requests ----------

  async fetchMergeRequests() {
    try {
      return await this.#fetchMergeRequestsGraphql();
    } catch (e) {
      // Auth problems won't be fixed by the REST fallback.
      if (e.status === 401 || e.status === 0) throw e;
      console.warn("GraphQL MR query failed, falling back to REST:", e.message);
      return this.#fetchMergeRequestsRest();
    }
  }

  async #fetchMergeRequestsGraphql() {
    const query = `
      fragment MR on MergeRequest {
        iid title webUrl draft updatedAt
        sourceBranch targetBranch
        detailedMergeStatus approved userNotesCount
        project { fullPath }
        author { username name avatarUrl }
        headPipeline { status }
        reviewers { nodes { username name avatarUrl mergeRequestInteraction { reviewState } } }
      }
      query {
        currentUser {
          username name avatarUrl webUrl
          authored: authoredMergeRequests(state: opened, sort: UPDATED_DESC, first: 50) { nodes { ...MR } }
          review: reviewRequestedMergeRequests(state: opened, sort: UPDATED_DESC, first: 50) { nodes { ...MR } }
          assigned: assignedMergeRequests(state: opened, sort: UPDATED_DESC, first: 50) { nodes { ...MR } }
        }
      }`;
    const { currentUser: u } = await this.graphql(query);
    if (!u) throw new GitLabError(401, "Not authenticated");
    const norm = (n) => ({
      key: `mr:${n.webUrl}`,
      iid: n.iid,
      title: n.title,
      url: n.webUrl,
      ref: `${n.project.fullPath}!${n.iid}`,
      project: n.project.fullPath,
      draft: n.draft,
      updatedAt: n.updatedAt,
      sourceBranch: n.sourceBranch,
      targetBranch: n.targetBranch,
      author: this.#user(n.author),
      pipeline: n.headPipeline?.status?.toLowerCase() ?? null,
      mergeStatus: n.detailedMergeStatus?.toLowerCase() ?? null,
      approved: n.approved,
      notes: n.userNotesCount ?? 0,
      reviewers: (n.reviewers?.nodes || []).map((r) => ({
        ...this.#user(r),
        state: r.mergeRequestInteraction?.reviewState?.toLowerCase() ?? null,
      })),
    });
    return {
      user: this.#user(u),
      authored: u.authored.nodes.map(norm),
      review: u.review.nodes.map(norm),
      assigned: u.assigned.nodes.map(norm),
    };
  }

  async #fetchMergeRequestsRest() {
    const me = await this.rest("/user");
    const base = { state: "opened", order_by: "updated_at", per_page: 50 };
    const [authored, review, assigned] = await Promise.all([
      this.rest("/merge_requests", { params: { ...base, scope: "created_by_me" } }),
      this.rest("/merge_requests", { params: { ...base, scope: "all", reviewer_username: me.username } }),
      this.rest("/merge_requests", { params: { ...base, scope: "assigned_to_me" } }),
    ]);
    const norm = (m) => ({
      key: `mr:${m.web_url}`,
      iid: m.iid,
      title: m.title,
      url: m.web_url,
      ref: m.references?.full ?? `!${m.iid}`,
      project: (m.references?.full ?? "").split("!")[0],
      draft: m.draft ?? m.work_in_progress,
      updatedAt: m.updated_at,
      sourceBranch: m.source_branch,
      targetBranch: m.target_branch,
      author: this.#user(m.author),
      pipeline: m.head_pipeline?.status ?? null,
      mergeStatus: m.detailed_merge_status ?? (m.has_conflicts ? "conflict" : null),
      approved: null,
      notes: m.user_notes_count ?? 0,
      reviewers: (m.reviewers || []).map((r) => ({ ...this.#user(r), state: null })),
    });
    return {
      user: this.#user(me),
      authored: authored.map(norm),
      review: review.map(norm),
      assigned: assigned.map(norm),
    };
  }

  // ---------- To-dos ----------

  async fetchTodos() {
    const todos = await this.rest("/todos", { params: { state: "pending", per_page: 100 } });
    return todos.map((t) => {
      const sigil = t.target_type === "MergeRequest" ? "!" : t.target_type === "Epic" ? "&" : "#";
      const iid = t.target?.iid;
      const path = t.project?.path_with_namespace ?? t.group?.full_path ?? "";
      return {
        id: t.id,
        key: `todo:${t.id}`,
        action: t.action_name,
        targetType: t.target_type,
        title: t.target?.title ?? t.body ?? "(untitled)",
        url: t.target_url,
        ref: iid != null ? `${path}${sigil}${iid}` : path,
        author: this.#user(t.author),
        body: t.body,
        createdAt: t.created_at,
        updatedAt: t.updated_at ?? t.created_at,
      };
    });
  }

  markTodoDone(id) {
    return this.rest(`/todos/${encodeURIComponent(id)}/mark_as_done`, { method: "POST" });
  }

  markAllTodosDone() {
    return this.rest("/todos/mark_as_done", { method: "POST" });
  }

  // ---------- Issues / work items ----------

  async fetchIssues() {
    const base = { state: "opened", order_by: "updated_at", sort: "desc", per_page: 50 };
    const [assigned, created] = await Promise.all([
      this.rest("/issues", { params: { ...base, scope: "assigned_to_me" } }),
      this.rest("/issues", { params: { ...base, scope: "created_by_me" } }),
    ]);
    const byId = new Map();
    const add = (i, flag) => {
      const existing = byId.get(i.id);
      if (existing) {
        existing[flag] = true;
        return;
      }
      byId.set(i.id, {
        key: `issue:${i.web_url}`,
        iid: i.iid,
        title: i.title,
        url: i.web_url,
        ref: i.references?.full ?? `#${i.iid}`,
        type: i.issue_type ?? "issue",
        labels: i.labels || [],
        updatedAt: i.updated_at,
        dueDate: i.due_date,
        notes: i.user_notes_count ?? 0,
        author: this.#user(i.author),
        assignees: (i.assignees || []).map((a) => this.#user(a)),
        confidential: i.confidential,
        assignedToMe: flag === "assignedToMe",
        createdByMe: flag === "createdByMe",
        [flag]: true,
      });
    };
    assigned.forEach((i) => add(i, "assignedToMe"));
    created.forEach((i) => add(i, "createdByMe"));
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  #user(u) {
    if (!u) return null;
    return {
      username: u.username,
      name: u.name,
      avatar: this.absolute(u.avatarUrl ?? u.avatar_url),
      url: u.webUrl ?? u.web_url ?? null,
    };
  }
}
