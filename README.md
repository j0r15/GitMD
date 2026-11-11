# gitmd

A small, self-hosted web editor for Markdown docs that live in a git
repository — looks and feels like HackMD/HedgeDoc (split edit/preview,
file sidebar), but every save is a real git commit pushed to your remote
with a deploy token, rather than a database row.

## How it works

- You list one or more git repos in `config.yaml`, each with a URL and a
  token (GitHub PAT, GitLab deploy token, etc).
- On startup the server clones each repo into `data_dir`.
- Opening the file list or a file re-syncs that repo (`fetch` +
  `reset --hard` to the remote branch) so you always start from the
  latest commit.
- Hitting **Save** writes the file, commits it, and pushes. If the push
  is rejected (someone/something else pushed in the meantime), gitmd
  does one `fetch` + `rebase` + retry; if that still conflicts, you get
  a 409 and are asked to reload.
- Only `.md` / `.markdown` files can be viewed, created, edited, renamed,
  or deleted — this is a docs editor, not a general file browser.
- A single shared password gates the whole app (session cookie, HMAC
  signed). There are no per-user accounts; commits are authored as the
  `commit_name` / `commit_email` configured per repo.

## Running it

```sh
cp config.example.yaml config.yaml
# edit config.yaml: set auth_password, session_secret, and your repo(s)
go build -o gitmd ./cmd/gitmd
./gitmd -config config.yaml
```

Then open `http://localhost:8080`.

Secrets in `config.yaml` can be written as `${ENV_VAR}` and are expanded
from the process environment at load time, so the token/password values
don't have to sit in the file on disk.

### Docker

```sh
docker build -t gitmd .
docker run -p 8080:8080 -v $(pwd)/config.yaml:/app/config.yaml:ro \
  -v gitmd-data:/app/data gitmd
```

## Hugo preview (`type: hugo`)

By default a repo renders with the built-in markdown-it preview
(`type: plain`). Set `type: hugo` on a repo whose content is an actual
hugo site (a `hugo.toml`/`config.toml` and `content/` at its root) and
the preview pane shows the real site instead:

- Opening a file (and, debounced, every edit) runs `hugo --destination
  <data_dir>/<repo-id>-site --baseURL .../preview/<repo-id>/` against the
  synced clone and serves the result back in an iframe.
- The edited file's path is mapped to the page it renders at using hugo's
  default content conventions (`content/<section>/<slug>.md` →
  `/<section>/<slug>/`, page bundles' `index.md`, `_index.md` → section
  root, etc). Custom permalinks, slugs, or aliases set in front matter
  aren't accounted for — if a page uses one, the preview falls back to
  the nearest guess rather than the exact URL.
- Needs the `hugo` binary on `PATH`. The Dockerfile installs a pinned
  extended release from upstream rather than `apk add hugo` — Alpine
  3.20 only packages hugo 0.125.4, too old for many current themes
  (0.146+ is a common minimum). If a theme needs an even newer hugo than
  the pinned default, bump `HUGO_VERSION`/`HUGO_SHA256` build args
  (`docker build --build-arg HUGO_VERSION=... --build-arg HUGO_SHA256=...`
  — get the sha256 for `hugo_extended_<version>_linux-amd64.tar.gz` from
  that release's `..._checksums.txt` asset on the hugo GitHub releases
  page). Running gitmd outside Docker needs a matching `hugo` on `PATH`
  yourself.
- A hugo build failure (wrong/missing config, a theme version mismatch,
  a broken template) surfaces hugo's own error text in the "Hugo build
  failed: ..." status message — read past the `exit status 1:` prefix,
  the actual reason is right after it.
- The build runs with a lock held per repo, so it's serialized against
  saves/syncs on that repo — a slow build briefly blocks the next one.

## Notes on deploy tokens

- **GitHub**: use a fine-grained PAT with read/write on the repo's
  contents; `username` is conventionally `x-access-token`.
- **GitLab**: create a Deploy Token with `write_repository` scope;
  `username` is the token's name (e.g. `gitlab+deploy-token-1`),
  `token` is the generated secret.
- **Gitea/Forgejo**: there's no separate "deploy token" type like
  GitLab's — generate a repo-scoped access token (Settings →
  Applications, `repo: read and write` scope) for a dedicated bot/service
  account, and set `username` to that account's name and `token` to the
  generated value.
- **Other forges**: any HTTPS basic-auth-compatible token works the same
  way — set `username`/`token` accordingly.

The token is sent as an `Authorization: Basic` header via git's
`http.extraHeader`, passed through environment variables rather than
`-c` flags or embedding it in the remote URL, so it doesn't show up in
`ps`, `git remote -v`, or `.git/config`.

Put gitmd itself behind a reverse proxy with TLS if it's reachable
outside a trusted network — the shared-password session cookie has no
other transport protection on its own.

## Deliberately out of scope

- Real-time multi-user collaborative editing (CRDT/websockets) — this is
  a single-editor, save-to-commit model.
- Per-user accounts/permissions — one shared password for the whole app.
- Editing non-Markdown files or arbitrary repo browsing.
