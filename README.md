# Beads Board for Orca

**Your Beads board, inside Orca.** See what is ready, follow dependencies, and update issues without leaving your workspace. Beads remains the source of truth; the panel works with your existing `bd` CLI and project.

[Русский](README.ru.md)

![Beads Board showing a demo project](docs/images/native-board-0.2.1.png)

*The board above is captured from the real Orca 1.4.250 plugin panel with synthetic tasks. Table/detail images below are historical browser captures; no private project data is published.*

## Install the stable release

Current release: **v0.2.5-ssh.2**. Install the native plugin directly from Git; no source build or development link is needed. Existing-session handoff remains disabled. Community-catalog discovery is separate and may require review.

In Orca, open **Settings → Plugins → Add plugin → From Git URL** and enter:

```text
https://github.com/quzard/beads-orca#v0.2.5-ssh.2
```

Alternatively, use the [Orca community catalog](https://onorca.dev/plugins/roflochinsky.beads?catalog=community) once listed. Check the [listing status](https://www.onorca.dev/plugins/roflochinsky/beads-orca) if it is not available there; Git installation does not require a community listing.

Requirements:

- Orca **1.4.250 or newer**.
- Beads CLI **1.3.2** on the execution host and an initialized Beads project.
- POSIX file semantics, remote `bash`, and `python3` for document/artifact operations. System SSH on the Mac for a Linux dev machine. An Orca SSH host synced from `~/.ssh/config` is used as that alias; `remoteHosts` only overrides it. `bd` must be on the remote PATH used by `bash --noprofile --norc` (the default search path includes `~/.local/bin` and `/usr/local/bin`).

Review the publisher and access request during installation, approve only if you trust the plugin, and open the **Beads Board** panel in Orca. Local Orca workspaces are listed automatically. To add another local project, use **Additional local Beads project paths** in the plugin settings, one absolute project path per line.

Choose a project by its workspace, host and full path in the project picker. Identical `main` or `develop` names do not identify the same database. “Not checked” means that the plugin has not read that workspace yet. Each workspace uses its own Beads configuration; the plugin does not migrate old databases or silently substitute another checkout.

> **Trust matters.** This is a trusted worker, not a sandboxed panel. It runs with the full access of your user account and invokes the local `bd` CLI to read and change tasks. Install it only if you trust the plugin and the selected projects. Review the requested Orca capabilities before approval.

## Work with your tasks (stable)

- **Find the next issue.** Switch between board and sortable table, search by title, ID, description, assignee or label, and filter by view, type, priority and assignee.
- **Keep large projects intact.** Replies travel in bounded chunks through Orca's 1 MiB bridge limit. Loading, unavailable and stale states are distinct; an unsuccessful read never becomes a misleading zero-issue board.
- **Understand dependencies.** See relationships in the board and issue details; highlight a task's blockers and dependents. Ready and blocked membership comes from Beads, not a separate rules engine.
- **Keep work moving.** Create and edit issues, manage dependencies and comments, and Claim, Close or Reopen from the panel. Closing offers a guarded Undo: it reopens only if the issue has not changed since it was closed.

| Table | Issue details |
| --- | --- |
| [![Sortable table of demo issues](docs/images/table.png)](docs/images/table.png) | [![Demo issue details and dependencies](docs/images/detail.png)](docs/images/detail.png) |

## New in 0.2.4

Board and table skeletons now preserve the shape of the view while projects or issues load. Background refresh keeps existing tasks visible. Loading labels and busy state are accessible; reduced-motion preferences disable the subtle pulse. Errors and empty workspaces never masquerade as loading.

## New in 0.2.3

Use **Epics → Filters** to narrow the epic list by status, priority and assignee; search still matches titles and IDs. Status is the epic's own Beads status, not a calculation from its children.

Epic-list filters do not change the task list. A selected epic outside the filters stays visible with a notice. **Reset** clears only the epic-list criteria, which also reset when switching projects. These navigation controls are session-local, separate from saved task filters.

No matching tasks now show a centered message across the content area, with **Reset task filters** or **Show all issues** to recover. The controls remain usable in compact panels.

## New in 0.2.2

The approved navigation and performance update:

- **Navigate by epic.** Epics sit below Views. Select an epic and its descendants, or No epic, while retaining the selected status.
- **Use consistent views.** Ready, In progress, Blocked, Closed and Deferred open tables. All issues remembers Board/Table. Header and sidebar counts use the same filters.
- **Create from the sidebar.** New issue lives under the project picker, including in compact panels.
- **Open documents in Orca.** Markdown tiles open the workspace editor. Preview and Include remain separate; Show more reveals additional attachments.
- **Keep large lists responsive.** Board and table render visible windows without truncating the loaded task set.

Download the plugin-only archive from [release v0.2.2](https://github.com/Roflochinsky/beads-orca/releases/tag/v0.2.2). Agent-assisted document suggestions are not part of this update. Epic navigation works without an SSH display name; saving a portable epic filter requires one.


## Stable release limits

The plugin adds a panel rather than replacing Orca's built-in Tasks. Existing-session handoff is disabled until Orca supports atomic idle-only submission. Sending a new-session handoff never automatically claims or closes a task. Remote access requires explicit SSH mapping; source and target must share an execution host.

Project configuration and routing are trusted. In Beads 1.3.2, the local-ID precheck and a subsequent write are not atomic: an external deletion between them can allow native prefix routing to another configured store. This plugin is not a database sandbox. See the [adapter contract](src/core/README.md) for details.

This repository is for Orca only. For Tern, see [beads-tern](https://github.com/Roflochinsky/beads-tern); for other hosts and the original browser HUD, see [beads-hud](https://github.com/Roflochinsky/beads-hud) and its [native integrations](https://github.com/Roflochinsky/beads-hud/tree/main/native).

## Workflows in 0.2.0

The plugin supports the following workflows:

- **Prepare explicit handoffs:** select tasks across projects, split them into source/target groups, review blockers and explicitly selected whole-file or line-range Markdown context, and choose implementation or research. Changed context rejects Send with details and requires a new preview. New CLI-session launch uses native Orca receipts; sending is not Claim, agent acceptance, or completion.
- **Work across hosts:** local projects and SSH projects whose Orca host name is a `~/.ssh/config` alias, host availability, and timestamped offline snapshots. The Beads source and target code workspace must share an execution host. Unmapped paired hosts stay visible but unsupported.
- **Keep context and review explicit:** linked Markdown read/open, personal filters and explicit project-filter publication, private handoff history with export/import/delete, native worktree preview/create, structured per-task reports, and explicit artifact cleanup. No automatic resend, task close, merge, push, or worktree deletion.

**Existing-session handoff remains blocked.** Orca lacks an atomic native idle-only send gate; discovered existing sessions are disabled rather than risk interrupting work.

Development requires Orca **1.4.250+**, Node **24+**, and `bd` **1.3.2** on the execution host. File access requires POSIX semantics and `python3`; remote access also requires system SSH and a `~/.ssh/config` alias (or a `remoteHosts` override). See [configuration and trust limits](docs/integration-constraints.md), including the standard native-profile restriction, editor-open race, and SSH-config caveat.

For 0.2.1, 78 tests, real-`bd` smoke and local build checks passed. The actual Linux Orca panel loaded 1,262 issues through the native bridge without truncation. **Actual model execution, Orca's native macOS UI and real paired-runtime behavior remain unverified.** Provider discovery does not prove authentication; imported history and reported results remain unverified claims for human review.

See the [workflow contract](docs/workflow.md) and [configuration and trust limits](docs/integration-constraints.md).

[View the handoff preview in native Orca](docs/images/native-handoff-unreleased.png). This genuine 1301×900 capture uses synthetic tasks and the release implementation without the test-only launch adapter; it does not show an agent launch.

## Development

From the repository root, with Node.js **24 or newer** and `bd` 1.3.2 installed:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run smoke
npm run package:plugins
```

The build produces `dist/orca`. The smoke uses a disposable Beads project and the built worker, not the real Orca UI. Local planning, review discussions and acceptance logs are excluded from Git.

For a local development load, inspect the request and follow the exact approval command returned by Orca:

```sh
orca-ide plugin validate ./dist/orca --json
orca-ide plugin dev load ./dist/orca --json
orca-ide plugin open local.beads --panel beads --json
```

On Linux outside an Orca terminal, use `orca-ide`: bare `orca` can refer to the system screen reader. The `local.beads` identity is for a development load, not the community catalog identity.

## License

[MIT](LICENSE). Third-party UI assets retain their own licenses; see the [asset notices](src/ui/THIRD-PARTY.md).
