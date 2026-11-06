# GitLab Helper

A Firefox extension that keeps your GitLab work one keystroke away, in the sidebar
(`Alt+Shift+G`) or the toolbar popup.

- **Inbox**: pending GitLab to-dos (mentions, review requests, failed pipelines…), with mark-as-done
- **Review**: open MRs where you're a reviewer, split into *waiting on you* / *already reviewed*
- **My MRs**: MRs you authored or are assigned, with pipeline status, merge blockers
  (conflicts, unresolved threads, needs approval…), approvals and reviewer states
- **Issues**: open issues/tasks/incidents assigned to or created by you
- Unread dots on MRs/issues updated since you last opened them
- Toolbar badge with the number of pending to-dos, plus desktop notifications for new ones
- Optional bookmarks folder mirroring your open MRs ("To review" / "My MRs"), kept in sync automatically
- Works with gitlab.com and self-managed instances

## Install (development)

```sh
npm install
npm start          # launches a temporary Firefox profile with the extension loaded
```

Or in your normal Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
→ pick `manifest.json` (it's removed when Firefox restarts).

For a permanent install in release Firefox the extension has to be signed:
`npm run sign` with AMO API credentials (`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`) produces
a self-distributable `.xpi`.

## Setup

On first install the settings page opens. Enter your GitLab URL and a
[personal access token](https://gitlab.com/-/user_settings/personal_access_tokens?name=GitLab+Helper&scopes=read_api).
Use the `read_api` scope. Marking to-dos as done is off by default; enabling it needs an `api` token.
After saving, the settings page shows the token's scopes and warns about any it doesn't need.

## Security model

- The configured token is the extension's **only** credential for GitLab.
- The extension has **no host permissions**. It calls GitLab's API cross-origin (GitLab serves
  `/api/*` with `Access-Control-Allow-Origin: *` and no credentials), so Firefox never lets it use
  your GitLab session, cookies or site storage, and it cannot read GitLab pages or tabs. Every request
  also sends `credentials: "omit"`.
- Consequences: avatars hosted on the instance (served outside the API) show as initials, and clicking
  an item always opens a new tab.
- Optional permission: `bookmarks`, requested only if you enable the bookmarks folder (and released
  when you disable it).
- Whoever can publish updates to the extension could change all this, so install a build you signed
  and control.

## Keyboard (in the panel)

`1`–`4` switch tabs · `/` filter · `r` refresh · `Esc` clear filter

## How it works

- `src/background.js` polls GitLab on an alarm (default every 3 min), stores the result in
  `storage.local`, updates the badge and sends notifications.
- `src/api.js` uses one GraphQL query for all MR lists (pipeline + reviewer states in one round-trip),
  falling back to REST on older instances; to-dos and issues use REST.
- `src/panel.*` is the shared sidebar/popup UI; it renders from storage and re-renders on change.
- No build step and no runtime dependencies.
