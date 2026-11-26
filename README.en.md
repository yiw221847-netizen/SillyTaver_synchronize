# 酒馆多端同步 · TavernSync v1.3.1

Server plugin for SillyTavern that syncs characters, chats, world info and presets to a **private GitHub repository**.

- Pure HTTPS against `api.github.com` — **no git binary, no npm dependencies** (Node 18+ built-in fetch)
- One commit per push, only changed blobs are uploaded, automatic retry with backoff
- Refuses to push to a public repository (chat logs must stay private)
- Pull backs up overwritten files to `~/.tavernsync/backups/<timestamp>/` and rejects unsafe remote paths (`../`, absolute paths)
- Live progress bar in the web panel (percent / files / MB), plus a front-end entry under Extensions that jumps to the panel
- Errors explain the next step (401 = token invalid, 404 = repo name or token scope, 409 = empty repo)
- `settings.json` is excluded by default (often tens of MB); files above the size limit are skipped

## Install

```yaml
# <SillyTavern>/config.yaml
enableServerPlugins: true
```

Copy this directory to `<SillyTavern>/plugins/tavernsync/`, restart SillyTavern, open
`http://127.0.0.1:8000/api/plugins/tavernsync/ui`.

Create a private, empty repository and a fine-grained token with **Contents: Read and write**.

## Networking

Defaults to direct access to `https://api.github.com`. If your network blocks it, point
*API base* at a small Cloudflare Worker reverse proxy (snippet in the Chinese README) —
the device itself needs no proxy software.

## Multi-device

Last push wins. Enable auto-push on one device only; on others: `pull` → use → `push`.
