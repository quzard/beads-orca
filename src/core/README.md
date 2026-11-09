# Native Beads core

`service.ts` exports `handleRequest(request, projects, target?)`. Hosts provide trusted `Project` records and, for a remote project, an explicit `SshTarget` (`destination`, optional absolute `configFile`); requests select an **ID**, never a filesystem path or SSH connection. This module requires Node 24 on the desktop and the installed `bd` CLI on the execution host's PATH. The command surface was inspected against `bd version 1.3.2 (9b65b9e19: HEAD@9b65b9e198ac)` using `bd schema` and each command's `--help`.

## Workspace and execution boundary

- A project path must be absolute and contain an accessible `.beads/` directory on its execution host. This deliberately refuses ancestor/home database discovery from uninitialized project folders. A remote project without an explicit SSH target, or a local project with one, is rejected.
- Local child processes use `cwd=project.path`, the canonical `BEADS_DIR`, `--json`, `--no-color`, and no shell. Remote operations use system SSH. The login shell only starts `env bash --noprofile --norc`; arguments stay quoted inside that bash script. Read commands also use `--readonly`. Request input cannot select arbitrary commands, flags, files, database names, actors, or connections.
- SSH uses optional `-F configFile`, `BatchMode=yes`, `ConnectTimeout=8`, no PTY, cleared forwardings, and a plugin-owned `ControlMaster` socket. Authentication/known-host trust must already work; no Orca secrets are extracted and no server/helper is installed. `ProjectAccess` owns settings, host availability, offline cache, and mapping identity checks; see [configuration](../../docs/integration-constraints.md). Its document/artifact file operations additionally require POSIX filesystem semantics and `python3` on the workspace host; native `bd` transport itself does not use Python. A `.beads` path whose physical directory leaves the workspace is refused before `bd` runs.
- Ambient database/endpoint selectors are removed, including legacy `BD_DB`, direct/shared Dolt selectors, proxied root/config selectors, central-config overrides, and their relevant `BD_DOLT_*` aliases. Project metadata, local config, `.env`, and native redirects remain the trusted database configuration. Put endpoint selection there rather than in an unrelated parent shell. Actor, replica identity, passwords, credential helpers, and TLS settings remain available; the core does not impersonate the assignee.
- `BD_ROUTING_MODE=explicit`, `BD_ROUTING_DEFAULT=.`, and create's `--repo=.` disable contributor/planning-repository auto-routing, **not prefix routing**. ID-based operations first require an exact full ID from the current project's uncapped `list --id=…`. IDs absent at that precheck are rejected before invoking the requested native operation. Dependency changes precheck both endpoints; creating external-capability references is not part of this RPC surface, but existing external edges remain visible.
- **This is not atomic project isolation.** The precheck and operation are separate CLI processes. If another actor removes the checked local ID between them, native 1.3.2 can resolve a partial local match or follow `routes.jsonl` into another, possibly unregistered, writable store. Project routing/configuration remains trusted. The in-host process queue cannot exclude external actors. Do not use this adapter as a database sandbox for untrusted project configuration.
- No supported 1.3.2 exact-local mutation/no-prefix-routing switch was found in the actual resolver, close path, or installed CLI help. `--db` still resolves the owning `.beads` routing directory; `--sandbox` disables auto-push, and `--readonly` prevents mutations entirely. The adapter retains the exact-ID precheck without pretending it closes the race, modifying/swapping routing files, or replacing native policy with direct SQL. A hard guarantee requires upstream atomic exact-local operations or independently enforced process/database confinement.
- `BD_DIRECTORY_LABELS={}` overrides `directory.labels` only in child processes. Thus snapshots, `ready`, and membership prechecks are not silently directory-filtered; actual issue labels remain hydrated. No project/user config is modified, and `--skip-labels` is not used because it would discard label data.
- Every request has a 30-second CLI deadline (including queue wait) and a 16 MiB aggregate stdout/stderr budget. Each text input is at most 64 KiB of decoded UTF-8. Bounds produce explicit errors, never truncated successful snapshots. Nonzero exits include command, status, and up to 8 KiB of native diagnostic output. No automatic retries are performed: a timed-out mutation may already have committed, so refresh before retrying.
- CLI processes are serialized inside one worker by canonical `.beads` directory plus local/SSH connection identity, avoiding concurrent embedded-Dolt opens through the same key. Different SSH aliases, other worker processes, and separately configured redirects still rely on native storage locking. A snapshot is multiple authoritative queries, **not** a database transaction.

## Command mapping

All entries below additionally receive the global flags above. Optional string flags use `--flag=value` so values beginning with `-` remain values. Positional data follows `--`.

| RPC | Native command |
| --- | --- |
| `projects` | No process; returns host registration records |
| `snapshot` | `list --all --limit=0 --flat --include-ephemeral --include-gates --include-infra --include-templates`; batched `dep list --direction=down -- ID…`; `ready --limit=0 --include-ephemeral`; `blocked` |
| `issue` | `show --brief-deps --id=ID`, then `dep list --direction=down -- ID ID` |
| `create` | `create --repo=. --title=… [--description=… --type=… --priority=… --assignee=… --labels=…]` |
| `update` | `update [--title=… --description=… --priority=… --assignee=… --status=… --notes=… --acceptance=… --design=…] -- ID` |
| `claim` | `update --claim -- ID` |
| `close` | `close [--reason=…] -- ID` |
| `reopen` | `reopen -- ID` |
| `reclaim` | `reclaim --id=ID` |
| `link` | `dep add [--type=…] -- ID DEPENDS_ON` |
| `unlink` | `dep remove -- ID DEPENDS_ON` |
| `comment` | `comment -- ID TEXT` |
| `comments` | `comments -- ID` |

`reclaim` is **not** unclaim or forced reassignment. Native lease expiry, default grace window (installed help: 10m), and replica protection apply; an active lease may yield no reclaimed issues. No `--older-than=0`, `--any-replica`, forced status update, or invented heartbeat threshold is added. Claims use the CLI's atomic claim operation. Reopen uses its dedicated native command and event.

## Schema observations and limits

- `list` defaults to 50 rows; `ready` defaults to 100. Both are explicitly uncapped. `blocked` exposes no limit option in 1.3.2. Native configured row circuit breakers remain errors rather than silently incomplete results.
- `bd schema` describes `dependencies` as raw `{issue_id, depends_on_id, type}` records. Actual `show --brief-deps` instead embeds issue-detail rows with `{id, dependency_type, …}`. Actual `list` can hydrate only some edges. Native `dep list` with **one argument** also hydrates targets and drops edges whose targets have no local row. Therefore both details and snapshots use raw multi-argument `dep list`; a singleton (including the last batch of a 201-issue snapshot) repeats its ID. Native `readDepListEdges` deduplicates anchors, so edges are not duplicated. This retains local, closed-target, and external-only edges.
- Status and issue-type strings are not narrowed to the schema enums: native custom statuses/types remain usable. Missing optional descriptions/assignees/labels become empty values, not guessed actors or statuses. `acceptance_criteria`, date fields, `estimated_minutes`, and `heartbeat_at` map to shared camelCase fields. The shared interface does not expose `lease_expires_at`.
- Native empty Go slices may be `null`; read collections normalize them to `[]`. Other malformed read results fail explicitly. Mutations have an unspecified RPC result shape; JSON is decoded when present, otherwise successful native text or `null` is returned. Consumers refresh after success.
- Comment rows remain native `{id, issue_id, author, text, created_at}`. Schema declares string IDs and RFC3339 timestamps. The isolated real-bd smoke creates and reads a populated comment.
- Labels are supplied as a correctly quoted CLI CSV list. This RPC rejects labels containing commas/newlines and caps the array at 100. Native validators remain authoritative for types, statuses, dependency kinds, and claim/close constraints.
- Installed 1.3.2's changelog notes that old workspaces crossing migration 0059 can retain incorrect `is_blocked` flags until an operator runs `bd recompute-blocked`. The core never repairs user data or substitutes its own readiness calculation.

## Pinned native source evidence

The inspected release source is `gastownhall/beads` **v1.3.2**, commit `9b65b9e198acbcc98e7fd3a87a5d55baa065a572`; installed identity during correction was `bd version 1.3.2 (9b65b9e19)`. These are source contracts, not a claim that the new regressions or smoke have been run.

- [Raw edge selection and singleton omission](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/dep.go#L940-L1052), [anchor deduplication](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/dep.go#L815-L827), and [upstream regression repeating the same ID](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/dep_list_cross_db_test.go#L89-L98).
- [Local miss followed by writable prefix routing](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/routed.go#L63-L91), [opening the routed store writable](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/routed.go#L162-L223), [independent close fallback](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/close.go#L834-L846), and [explicit database paths resolving to the owning routing directory](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/main.go#L764-L790).
- [List directory filters](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/list_input.go#L320-L324), [ready directory filters](https://github.com/gastownhall/beads/blob/v1.3.2/cmd/bd/ready_input.go#L204-L210), [BD-prefixed dotted-key environment mapping](https://github.com/gastownhall/beads/blob/v1.3.2/internal/config/config.go#L207-L213), and [directory-label map lookup](https://github.com/gastownhall/beads/blob/v1.3.2/internal/config/config.go#L887-L918). Pinned Viper 1.21.0 [prefers environment to config](https://github.com/spf13/viper/blob/v1.21.0/viper.go#L1230-L1254); its Cast 1.10.0 dependency [decodes the JSON map string](https://github.com/spf13/cast/blob/v1.10.0/map.go#L14-L61), so `{}` is a valid empty-map override, not an invented CLI flag.


## Verification

The automated checks below exercise the adapter contract. They do not establish actual model execution, native macOS UI behavior or real paired-host compatibility.

`tests/core.test.ts` covers the public request seam with an external fake `bd` process: project/input restrictions, 201-row snapshots ending with a singleton external-only edge batch, detail raw-edge precedence, directory-default suppression without losing labels, native ready/blocked membership, closed and hidden statuses, field normalization, empty/malformed/oversized/error output, ambient selector handling with preserved credentials/actor, registered-ID precheck refusal, and same-workspace process serialization. These tests do not establish atomic isolation from external writers.

`scripts/smoke.mjs` loads the built Orca worker with a minimal host registration harness and prepares only a disposable native project with directory defaults and an existing external edge. Its panel handler calls the real installed `bd`; it checks singleton snapshots/details and local dependencies before and after closing their target. This does not replace validation and read/write checks in the actual Orca application.

Commands from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run smoke
```

To run just the compiled core regression file after `npm test` bundles the tests:

```sh
node --test .test-dist/tests/core.test.js
```

For an **actual isolated CLI smoke**, use a new temporary directory and a child-only environment. Clear inherited `BEADS_*`, `BD_*`, and `DOLT_*` variables in that fixture process; set isolated `HOME`, `XDG_CONFIG_HOME`, and `BEADS_ACTOR=beads-smoke`. Keep `PATH` so the real binary is used. Initialize only the temporary repository:

```sh
git init
bd init --prefix=smoke --non-interactive --skip-agents --skip-hooks
bd --json create --repo=. --id=smoke-blocker --title='Smoke blocker' --description='Isolated fixture'
bd --json create --repo=. --id=smoke-dependent --title='Smoke dependent' --description='Isolated fixture'
bd --json dep add -- smoke-dependent smoke-blocker
bd --readonly --json ready --limit=0
bd --readonly --json blocked
bd --json update --claim -- smoke-blocker
bd --json comment -- smoke-blocker 'Smoke comment'
bd --readonly --json comments -- smoke-blocker
bd --json update --notes='Smoke notes' --acceptance='Smoke acceptance' --design='Smoke design' -- smoke-blocker
bd --json reclaim --id=smoke-blocker
bd --readonly --json show --id=smoke-blocker
bd --json close --reason='Smoke complete' -- smoke-blocker
bd --readonly --json ready --limit=0
bd --readonly --json list --all --limit=0 --flat
bd --readonly --json dep list -- smoke-dependent smoke-dependent
bd --json reopen -- smoke-blocker
bd --readonly --json blocked
bd --json dep remove -- smoke-dependent smoke-blocker
bd --readonly --json ready --limit=0
```

Run the same sequence through `handleRequest` using that temporary project to exercise normalization and the transport seam. Assert the dependent is initially blocked, becomes ready after blocker close while its edge to the closed blocker remains, blocks again on reopen, and becomes ready on unlink. Assert claim uses `beads-smoke`, comments preserve their content/author, and reclaim does not steal a live lease. For a positive expired-lease reclaim test, arrange lease expiry only inside this disposable database with native fixture tooling; do not add a forced-reclaim flag to the RPC or touch the user's database.
