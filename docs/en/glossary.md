---
title: Glossary
tags: [glossary, reference]
---

# Glossary

Terms that show up across these docs, defined once. If a term should be here and isn't, open an issue.

## A

**Adapter (Obsidian)**
The interface Obsidian uses to read/write files in a vault (`vault.adapter`). The plugin's shadow-vault model leaves the local adapter pointing at a real on-disk vault and routes file operations through the daemon RPC instead.

**Auto-deploy** *(of the daemon)*
The default behavior: when you connect via an RPC profile, the plugin uploads the daemon binary to the remote and starts it under your SSH user. See [[en/server/auto-deploy|Server / auto-deploy]].

## B

**BRAT** — *Beta Reviewers Auto-update Tool*
[obsidian42-brat](https://github.com/TfTHacker/obsidian42-brat) — a community plugin that installs other plugins straight from a GitHub repo's `manifest-beta.json`. We publish every merge to `next` as a BRAT-installable prerelease. See [[en/getting-started/install|Install]].

## C

**Channel** *(release)*
Either **stable** (main branch, plain `X.Y.Z`, Obsidian Community Plugins store) or **beta** (next branch, `X.Y.Z-beta.N`, BRAT --beta). The version shape is the source of truth — see the project's `CONTRIBUTING.md` Branching model.

**Client ID**
Per-device identifier, settable in **Settings → This device**. The plugin uses it to namespace the per-client `.obsidian/user/<client-id>/` subtree on the remote vault so multiple devices' workspace state doesn't collide. See [[en/configuration/this-device|Configuration → This device]].

**Cosign keyless**
[Sigstore](https://www.sigstore.dev/) signing flow that binds a signature to a CI workflow identity (no private keys to manage). The release pipeline signs every daemon binary this way. See [[en/security/cosign-verify|Cosign verify]].

## D

**Daemon** — *the server-side `obsidian-remote-server` process*
A single Go binary that listens on a Unix socket on the remote, mediates all vault file operations, and authenticates the plugin via a per-startup token. See [[en/server/overview|Server overview]].

**Daemon panel**
The settings sub-panel that appears when an RPC profile has an active daemon — shows version + capabilities + a "View log" button. See [[en/operations/daemon-panel|Daemon panel]].

## F

**Fingerprint** *(host key)*
The colon-separated SHA-256 of the remote SSH host key (e.g. `aa:bb:cc:dd:…`). The plugin's host-key store maps `host:port` to fingerprint and uses it on every reconnect to detect MITM. See [[en/security/host-keys|Host-key trust]].

**`fs.changed`**
Server-pushed JSON-RPC notification announcing a file/directory tree change. The plugin subscribes via `fs.watch` and uses these to keep the shadow vault in sync. See [[en/api/watch|API → watch]].

## H

**Host-key store**
The plugin's own `known_hosts` equivalent (separate from `~/.ssh/known_hosts`). Persisted as the `hostKeyStore` key in the plugin's `data.json`. See [[en/security/host-keys|Security → Host-key trust]].

## J

**JSON-RPC 2.0**
The wire protocol the plugin and daemon speak. All `fs.*` calls + `auth` + `server.info` follow the [JSON-RPC 2.0 spec](https://www.jsonrpc.org/specification) over a length-prefixed framing on a Unix socket. See [[en/api/overview|API overview]].

**Jump host** *(bastion)*
An intermediate SSH host you must traverse before reaching the target. Configurable per-profile; see [[en/user-guide/jump-host|Jump hosts]].

## M

**Manifest**
The plugin's metadata file (`manifest.json`). The repo has three: `plugin/manifest.json` (canonical, bundled in the .zip), root-level `manifest.json` (mirrored for the Obsidian Community Plugins store), and root-level `manifest-beta.json` (mirrored for BRAT --beta). See `CONTRIBUTING.md` → Version bumps for how they stay in sync.

**MITM** — *Man-in-the-Middle*
An attacker positioned between you and the remote host, attempting to intercept traffic. The plugin's host-key check + SSH transport make passive MITM ineffective; defending against active MITM requires verifying the host key out-of-band. See [[en/security/model|Security threat model]].

## N

**`next`** *(branch)*
The integration / beta channel. Day-to-day work merges here; every merge publishes a `vX.Y.Z-beta.N` GitHub prerelease. See `CONTRIBUTING.md` → Branching model.

## P

**Profile** *(SSH)*
A named connection target — host, port, user, auth, remote vault path, optional jump-host chain. Configured under **Settings → Profiles**. See [[en/configuration/profiles|Configuration → Profiles]].

**Promotion PR**
A `next → main` PR that drops the `-beta.N` suffix and ships the accumulated work as a stable release. The `bump:stable` script in `plugin/scripts/bump-stable.mjs` strips the suffix.

## R

**Reconnect manager**
The component that retries an SSH session after a transport drop. Uses exponential backoff (×1.5, ±20% jitter, 30 s cap) up to a configurable retry budget. See [[en/operations/reconnect|Reconnect behavior]].

**RPC mode**
The default-recommended transport mode — plugin auto-deploys the daemon and speaks JSON-RPC over an SSH-tunneled Unix socket. Faster than SFTP and supports server-push `fs.changed` events. The current factory default is **SFTP mode** (legacy); switch the profile **Mode** field to opt in.

## S

**SFTP mode**
The current factory default transport — uses SSH's SFTP subsystem directly (no daemon). Higher per-op latency, no `fs.watch`, but works on hosts where you cannot deploy a binary.

**Shadow vault**
A local Obsidian vault under `~/.obsidian-remote/vaults/<profile-id>/` whose adapter sends every read/write straight to the remote — the single source of truth, **not** a synced copy. Only `.obsidian/` is on disk; notes are virtual. Exception: plugins writing via raw Node `fs` instead of the vault API stay local (#429). See [[en/architecture/shadow-vault|Shadow vault architecture]].

**Sync workflow** — *`.github/workflows/sync-main-to-next.yml`*
After every push to `main`, opens a PR `main → next` and enables auto-merge so the histories rejoin. Prevents drift between channels.

## T

**TOFU** — *Trust On First Use*
The "first time you see this host's key, you decide whether to trust it" model. The plugin shows a fingerprint dialog on first connect; trusting writes the fingerprint into the host-key store for silent verification thereafter. See [[en/security/host-keys|Host-key trust]].

**Token** *(daemon auth)*
A 32-byte random secret the daemon writes to `~/.obsidian-remote/token` (mode 0600) at startup. The plugin reads it via SFTP and presents it on the `auth` RPC. See [[en/security/token|Token & socket]].

**Trust-once**
Trust a host-key fingerprint for the current session only — held in RAM, dropped on disconnect. Available as a button on the TOFU (first-trust) dialog. NOT available on the mismatch dialog.

## V

**Vault population**
The process of registering the remote tree in the shadow vault's in-memory model for File Explorer, search, graph, and links.

**Vault root**
The absolute path on the remote filesystem that the daemon treats as the vault. Configured per-profile. The daemon refuses any path that escapes this root (`PathOutsideVault` error).

## W

**Wikilink**
The `[[target|alias]]` syntax used throughout these docs. Quartz resolves them via shortest-path matching from the docs root (`docs/`).
