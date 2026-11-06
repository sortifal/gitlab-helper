const $ = (id) => document.getElementById(id);
const form = $("form");
const fields = {
  baseUrl: $("baseUrl"),
  token: $("token"),
  allowWrite: $("allowWrite"),
  pollMinutes: $("pollMinutes"),
  notify: $("notify"),
  bookmarks: $("bookmarks"),
  bookmarkFolder: $("bookmarkFolder"),
  bookmarkParent: $("bookmarkParent"),
  bookmarkStatus: $("bookmarkStatus"),
};
const result = $("result");
const createToken = $("createToken");

// Scopes this extension can use; anything else on the token is unnecessary.
const USEFUL_SCOPES = new Set(["read_api", "api", "read_user"]);

function setResult(text, kind = "") {
  result.textContent = text;
  result.className = kind;
}

function updateTokenLink() {
  try {
    const base = normalizeBaseUrl(fields.baseUrl.value || DEFAULT_CONFIG.baseUrl);
    const scope = fields.allowWrite.checked ? "api" : "read_api";
    createToken.href = `${base}/-/user_settings/personal_access_tokens?name=GitLab+Helper&scopes=${scope}`;
  } catch {
    createToken.removeAttribute("href");
  }
}

function updateBookmarkOptions() {
  $("bookmarkOptions").hidden = !fields.bookmarks.checked;
}

function scopeWarnings(scopes, allowWrite) {
  const warnings = [];
  const extra = scopes.filter((s) => !USEFUL_SCOPES.has(s));
  if (extra.length) warnings.push(`unneeded scopes: ${extra.join(", ")}`);
  if (scopes.includes("api") && !allowWrite) warnings.push("has write access (api) but writes are off; read_api is enough");
  if (allowWrite && !scopes.includes("api")) warnings.push("marking to-dos as done needs the api scope");
  return warnings;
}

fields.baseUrl.addEventListener("input", updateTokenLink);
fields.allowWrite.addEventListener("change", updateTokenLink);
fields.bookmarks.addEventListener("change", updateBookmarkOptions);

form.addEventListener("submit", (e) => {
  e.preventDefault();

  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(fields.baseUrl.value);
  } catch {
    setResult("Enter a valid URL.", "err");
    return;
  }

  // permissions.request must run synchronously inside the user gesture,
  // so it is called before any await. Only the bookmarks permission is ever
  // requested; the extension never gets access to the GitLab host itself.
  const wantBookmarks = fields.bookmarks.checked;
  const permission = wantBookmarks
    ? browser.permissions.request({ permissions: ["bookmarks"] })
    : browser.permissions.remove({ permissions: ["bookmarks"] }).then(() => true);

  permission.then(async (granted) => {
    if (!granted) {
      setResult("Bookmarks permission is required for the bookmarks folder.", "err");
      return;
    }
    const config = {
      baseUrl,
      token: fields.token.value.trim(),
      allowWrite: fields.allowWrite.checked,
      pollMinutes: Math.min(60, Math.max(1, Number(fields.pollMinutes.value) || DEFAULT_CONFIG.pollMinutes)),
      notify: fields.notify.checked,
      bookmarks: wantBookmarks,
      bookmarkFolder: fields.bookmarkFolder.value.trim() || DEFAULT_CONFIG.bookmarkFolder,
      bookmarkParent: fields.bookmarkParent.value,
      bookmarkStatus: fields.bookmarkStatus.checked,
    };
    setResult("Checking…");
    try {
      const client = new GitLabClient(config.baseUrl, config.token);
      const me = await client.rest("/user");
      await browser.storage.local.set({ config });
      let message = `Connected as @${me.username}.`;
      let kind = "ok";
      try {
        const token = await client.rest("/personal_access_tokens/self");
        message += ` Token scopes: ${token.scopes.join(", ")}`;
        if (token.expires_at) message += ` (expires ${token.expires_at})`;
        const warnings = scopeWarnings(token.scopes, config.allowWrite);
        if (warnings.length) {
          message += `. Warning: ${warnings.join("; ")}.`;
          kind = "err";
        }
      } catch {
        // Older instances or non-personal tokens can't report their scopes.
      }
      setResult(message, kind);
    } catch (err) {
      setResult(err instanceof GitLabError ? err.friendly : String(err), "err");
    }
  });
});

(async () => {
  const config = await getConfig();
  for (const [key, el] of Object.entries(fields)) {
    if (el.type === "checkbox") el.checked = config[key];
    else el.value = config[key];
  }
  updateTokenLink();
  updateBookmarkOptions();
})();
