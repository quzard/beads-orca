# Changelog

## 0.2.5-ssh.2 — 2026-11-09

- SSH workspaces whose Orca host name is a `~/.ssh/config` Host alias connect without `remoteHosts`. The plugin reads `orca host list` and uses that name as `ssh` destination, with no `-F`, so OpenSSH reads the default config.
- `remoteHosts` remains an override for a renamed Orca host, a different destination, or another config file. Paired `runtime:` hosts still need an explicit entry.
- `engines.orca` stays `>=1.4.250`.

## 0.2.5-ssh.1 — 2026-11-09

- Remote Beads commands now start with `env bash --noprofile --norc` and a configurable PATH, so a login shell (`fish`, `zsh`, or `.bashrc`) cannot alias or wrap `bd` and `python3`.
- `.beads` must stay inside the workspace after `pwd -P`. A symlink to another database is refused locally and over SSH.
- SSH worktree creation uses `orca worktree create --project <id> --host ssh:…`. `agent launch` does not gain `--host`, because Orca 1.4.250 and the current quzard/orca-fork reject that flag; launch still requires `worktree show` to report the same host and path.
- SSH calls share a plugin-owned `ControlMaster` socket. The default refresh is 60 seconds when a remote host is configured, and the remote command budget is 60 seconds. Both are settings.
- Authentication, reachability, missing bash, missing `bd`, missing `python3`, a missing `.beads`, and a `.beads` outside the workspace are separate errors.
- One bad line in additional project paths is skipped and reported. The other workspaces still load.
- Hosts in the panel can test an SSH mapping and copy a `remoteHosts` snippet for an unmapped host. The plugin id stays `beads`.

## 0.2.4 — 2026-11-07

- Replaced text-only project/issue loading screens with layout-aware board and table skeletons in the existing warm monochrome palette.
- Kept loaded tasks visible during background refresh; initial loads, project switches and retries use placeholders until their own data arrives.
- Added accessible busy state and loading labels without announcing false zero counts. Placeholder decoration is hidden from assistive technology.
- Limited loading motion to one opacity animation and made reduced-motion loading static. Error and empty-project states remain distinct from loading.

## 0.2.3 — 2026-11-07

- Added independent epic-list filters for raw Beads status, priority and assignee, including Unassigned, alongside title/ID search.
- Kept the selected epic visible when it falls outside the list filters, with an explicit notice. Resetting epic filters does not change task filters or selection; changing projects clears the epic-list criteria.
- Added matching/total epic counts and accessible collapsible controls for desktop and compact panels.
- Replaced the corner-aligned no-results message with a centered full-content-area state and explicit reset/show-all actions, including recovery for closed-only projects.
- Prevented compact filter sections from overlapping task navigation and kept view counts readable at narrow panel widths.

## 0.2.2 — 2026-11-07

- Moved New issue into the workspace sidebar, with one visible creation action and the existing keyboard shortcut.
- Added Epics below Views, descendant-aware filtering, explicit No epic, and portable project/host-qualified saved epic filters. Missing ancestry is not treated as No epic.
- Status views now always open a table. All issues retains its Board/Table preference; counts share the same facets, and Include closed applies only to All issues.
- Replaced whole-panel rebuilding with independently updated regions and measured, overscanned board/table windows. Filtering and selection still cover the complete snapshot.
- Kept the detail close button visible, moved focus into details, restored focus on close, and made Escape close the foreground surface before clearing search.
- Presented Markdown links as document tiles with filenames, independent Preview/Include actions and Show more. Clicking a tile opens the file in its Orca workspace editor, without a browser fallback.
- Passed 91 tests, real-`bd` smoke, source/bundle validation and resource/checksum checks.
- Excluded local planning, review discussions and harness records from Git while retaining plugin code, CI and public technical documentation.
- Fixed epic navigation for supported SSH projects without an optional display name; portable saved filters still require a named host.
- Removed duplicate selection scans, drawer modality updates and virtual-window offset calculations identified in review.

## 0.2.1 — 2026-11-07

- Fixed large snapshots rejected by Orca's 1 MiB native reply limit. A bounded, identity-checked transfer protocol reconstructs complete replies without truncation or automatic application retries.
- Added transfer expiry, cancellation and cleanup, plus regression coverage for large Unicode/escaped replies, concurrent panels, invalid chunks, capacity limits and mutation failures.
- Replaced ambiguous project names with a keyboard-accessible picker showing project, workspace, host and path. Prefer an unambiguous current workspace on first load.
- Separated loading, unavailable, stale and live data. Removed false zero counts and duplicate load errors; technical diagnostics are expandable.
- Grouped secondary workflows, preserved keyboard focus across renders and improved compact-panel controls without changing the existing visual language.
- Preserved read-only data loading, database configuration and all existing-session/remote-access limitations. No automatic migration or fallback to a different checkout.

## 0.2.0 — 2026-11-07

Published with the known existing-session limitation retained. Install from `https://github.com/Roflochinsky/beads-orca#v0.2.0`; runtime source is unchanged from the tested preview.

- Added native workspace/host identities, explicit `remoteHosts` SSH configuration, same-host source/target checks, and timestamped offline snapshot caching with writes disabled. Unsupported paired hosts remain visible; SSH access does not inherit Orca credentials.
- Added cross-project task selection and explicit handoff groups, blocker-aware implementation/research previews, actionable stale-preview rejection with changed categories/IDs/paths, and a distinct declared Claim actor per handoff. Rejected previews require explicit renewal; Claim instructions do not enforce agent behavior.
- Added native new-CLI-session launch handling with exact receipt states, unknown-outcome journaling before side effects, and no automatic resend. Provider discovery checks executables, not authentication. Actual model launch/execution has not been observed.
- Added linked/manual Markdown read/open and explicit whole-file or inclusive line-range context with full-file hash revalidation, personal filters and explicit `.beads-orca/filters.json` publication, private chunked history with export/import/delete, and inert unverified imported archives.
- Added native worktree preview/create with setup skipped, full-context artifacts for long prompts, validated per-task report loading, reported-file navigation, explicit concise Beads publication, and separate artifact cleanup. No automatic task close, merge, push, or worktree deletion.
- Kept existing-session dispatch disabled: Orca 1.4.250 and inspected upstream 1.4.252 lack an atomic native idle-only submission gate. This remains an unwaived full-acceptance blocker.
- Passed Ubuntu/macOS CI, Linux real-SSH/offline and native panel/worktree/fragment/stale-preview checks. Verified public Git installation of source commit `035d4a2a2448439a6127f2a5ad03cc6b36fd8963`. Kept synthetic launch-adapter evidence separate from actual model execution. Native Orca UI on macOS, real paired runtime and nondefault-profile dispatch remain unverified. See [integration constraints](docs/integration-constraints.md).
- Fixed non-JSON optional snapshot fields, opaque native CLI refusal messages, headless browser confirmations, and handoff controls changing while recipient discovery or preview was in progress.

## 0.1.2 — 2026-11-06

- Added a root format-2 manifest and native TypeScript source loading for installation through Orca's Git URL flow, without a build or development link.
- Added MIT licensing, preserved third-party notices, and prepared public discovery metadata with screenshots.
- Published bilingual repository documentation separating current task-board capabilities from the approved agent-handoff, remote-workspace, history and filter roadmap.
- Kept the plugin-only archive and added CI checks for source resources, bundled resources and archive checksums. No editor, Electron runtime or other host implementation is included.
- Tern now has its own repository, [beads-tern](https://github.com/Roflochinsky/beads-tern); the remaining native hosts stay in beads-hud.
- Fixed discovery of local workspaces reported by Orca with `hostId: "local"`; remote-host paths remain excluded from the local adapter.

## 0.1.1 — 2026-11-06

- Made this repository exclusively the Orca plugin. Other integrations, native desktop delivery and the synthetic design reference belong to [beads-hud/native](https://github.com/Roflochinsky/beads-hud/tree/main/native); the original browser HUD remains at the repository root there.
- Removed non-Orca hosts, desktop/tray and HTTP transports, options, actions, styles, assets, tests and build dependencies rather than retaining dormant implementations.
- Preserved `dist/orca`, `local.beads` and the minimal `workspace:read` / `settings:own` permissions.
- Kept the installed-bd core, board/table behavior, search-focus correction, dependency spotlight, drag operations, edited-field updates, comments and guarded close undo.
- Changed real-bd smoke to exercise the built Orca worker panel handler, independent of another host's build output. Core regression tests remain unchanged.
- Simplified Node 24 build/test/CI dependencies and lockfile. Tags `v*` now release only the current Orca tarball and SHA256SUMS; desktop/native releases belong to HUD's `native-v*` workflow.
- Verified typechecking, build, 11 core tests, real-bd worker smoke, the actual Orca panel and Claim/Close/Reopen through the installed worker. Both the release workflow and main CI passed; the published Orca archive checksum was verified after download.

## 0.1.0 — 2026-11-06

Initial combined release, before repository ownership was separated. Orca included real Beads create, update, claim, close, reopen, reclaim, dependency and comment operations, board/table views, native readiness filters, keyboard actions and guarded close undo. Singleton native dependency edges, directory-default filtering suppression and search focus fixes are retained in 0.1.1. Historical non-Orca delivery and its documentation now belong to [beads-hud/native](https://github.com/Roflochinsky/beads-hud/tree/main/native).

Known runtime limits are documented in [integration constraints](docs/integration-constraints.md).
