# Orca and Beads integration constraints

Local/SSH access and explicit workflow operations use Orca's native workspace identities. Existing-session dispatch needs an upstream atomic idle-only gate. The [workflow contract](workflow.md) describes application behavior. These constraints were inspected against Orca 1.4.250 / Host API 1.3 and Beads 1.3.2; inspection of Orca 1.4.252 did not resolve that gate.

## Remote configuration and execution

The trusted Node worker runs on the desktop; selecting a remote workspace does not move it. `ProjectAccess` resolves registered native workspace IDs, paths, and hosts. Local projects use installed `bd`; remote projects use the same native CLI through **system SSH**, not terminal-screen parsing, direct database access, or `bd serve`.

An SSH workspace needs no `remoteHosts` entry when its Orca host was synced from `~/.ssh/config`. The workspace `hostId` is `ssh:` plus the URL-encoded internal target id, not the alias. `orca host list --json` returns that id and a `name`. For a synced host, `name` is the `Host` token (`new_sls`, `mini`). The plugin uses that name as the `ssh` destination and does not pass `-F`, so OpenSSH reads the Mac's default `~/.ssh/config` (including `HostName`, `User`, `Port`, and `IdentityFile`). The plugin does not read Orca's stored user, address, or key path, and it does not reuse Orca's SSH socket.

`remoteHosts` is only an override, keyed by the exact workspace `hostId`. Use it when the Orca display name is no longer the alias, when another destination or config file is required, or for a paired `runtime:` host. For example:

```json
{
  "ssh:example-host-id": {
    "destination": "beads-build",
    "configFile": "/home/example/.ssh/config",
    "name": "Build host"
  }
}
```

- `destination` is a configured system SSH alias or destination, not an arbitrary shell command. `configFile` is optional and must be an absolute path **on the desktop**; it is passed as `ssh -F`. Omit it to keep the default config. `name` is an optional portable display label used by shared filter scopes. No other mapping keys are accepted. Do not put credentials in this setting. An override replaces the automatic alias for that host id.
- The plugin does not reuse Orca's SSH session. It opens its own `ssh` from the Mac. A usable `~/.ssh/config` alias needs `HostName`, `User`, `IdentityFile`, and any `ProxyJump` you already use. `BatchMode=yes` will not unlock the keychain, so the key must already be in the agent or have no passphrase.
- SSH uses `BatchMode=yes`, `ConnectTimeout=8`, no PTY, and cleared forwardings. Repeated calls in one request share a `ControlMaster` socket under the system temp directory (`beads-orca-ssh/`, mode `0700`, `ControlPersist=60`). Configure known-host trust separately; the plugin neither extracts Orca secrets nor performs interactive authentication.
- Remote commands run as `env -u BASH_ENV -u ENV bash --noprofile --norc -c …`. The login shell, including fish and zsh, only starts that bash binary. `.bashrc` and `.zshenv` do not wrap `bd`. A missing bash is a distinct error. `remotePath` is prepended to the SSH default PATH; the default includes `~/.local/bin`, `~/bin`, and `/usr/local/bin`.
- The execution host needs an initialized `.beads/` directory whose physical path stays inside the workspace, plus `bd` 1.3.2 and `python3` on that PATH. A symlink from `.beads` to another database is refused. Confined file reads, metadata inspection, writes, and cleanup require **POSIX filesystem semantics and `python3` on the workspace host**, including local file access. This is not a Windows parity claim.
- SSH workspaces that are missing from `orca host list`, or whose Orca name is not an alias, stay visible. The Hosts view shows the host id and a copyable `remoteHosts` override. **Test SSH connection** checks bash, `bd`, `bd --version`, `python3`, `pwd -P`, and whether `.beads` is inside the workspace. A failure to run `orca host list` does not hide local projects.
- One invalid `projectPaths` line is reported and skipped. It does not remove the other workspaces. Empty `refreshSeconds` means 15 seconds locally and 60 seconds when a remote host is configured. Empty `commandTimeoutSeconds` means 30 seconds locally and 60 seconds over SSH.
- `orca agent launch` on Orca 1.4.250 does not accept `--host`. SSH handoff passes the worktree id and continues only when `worktree show` reports the same host and path. `worktree create` does accept `--host`, but only together with `--project`; the plugin looks up that project with `project setups --host ssh:…` and refuses to guess when the repo id exists on more than one machine.
- `projectPaths` remains newline-separated **local** absolute paths. A remote path with the same spelling is never treated as a local substitute.
- A `runtime:…`/paired host ID may be explicitly mapped to an SSH destination for file/Beads access. Without that mapping it stays visible as unsupported; there is no general paired-runtime file/exec adapter. Native paired CLI addressing is implemented but a real paired environment has not been exercised.
- **Source Beads project and target code workspace must have the same execution-host identity.** Desktop access to both hosts does not grant the target agent cross-host credentials. Separate worktrees can share a source database only through that original same-host source directory; the plugin never copies `.beads`.
- Current-workspace identification requires a unique native name/branch match. Ambiguous matches do not silently pick a workspace. Truncated native workspace lists are explicit errors.

Offline snapshots are compressed/chunked in private native storage and retain the original fetch time after worker restart. Offline data is visibly stale; writes and new handoffs are blocked. Private history/filter controls remain available. Storage failure is visible, not a promise of unlimited offline retention.

Access checks pin workspace/path/host and the SSH destination/config-file-path fingerprint. Editing that mapping invalidates captured identities. **Changing the contents of the same SSH config file is not detected by this fingerprint**: keep config, aliases, and host routing trusted and stable during an operation.

Sources: [project access](../src/orca/projects.ts), [native Beads/SSH adapter](../src/core/service.ts), [settings and capabilities](../orca-plugin.json).

## Native dispatch and profile boundary

New sessions use the native CLI `agent launch --surface terminal`, with explicit workspace/host selectors. Local and SSH targets address the desktop runtime; explicitly mapped paired targets use a native environment selector. New CLI session ids are Grok, Claude, Codex, Qoder CLI, OMP, Antigravity, Cursor, and Droid, matching `orca agent launch --agent`. Discovery checks the target-host binary Orca actually probes (`agy` for Antigravity, `cursor-agent` for Cursor, `qodercli` or `qoder` for Qoder CLI). Amp is not offered. Discovery checks executable presence only: it does **not** prove login, API credentials, model availability, billing access, or readiness. Provider setup belongs to the existing native CLI, not a second plugin model runtime.

The CLI child strips inherited `ELECTRON_RUN_AS_NODE`, `ORCA_PAIRING_CODE`, and `ORCA_ENVIRONMENT`. Although the child wrapper preserves `ORCA_USER_DATA_PATH` if present, **Orca strips that variable before starting the plugin worker**. Observed worker-side CLI discovery therefore used the standard HOME profile. A private native fixture exposed its own profile at `HOME/.config/orca`; no real user profile was touched. Custom nondefault-profile dispatch is not supported/proven; do not assume an externally configured CLI profile reaches the worker.

A terminal handle or `accepted` response is not delivery proof. Only an explicit native `prompt.outcome` is recorded as `journaled` (durable retention) or `handed-to-terminal` (terminal handoff). Neither proves a started model turn, Claim, or task completion. Unknown/error receipts remain unknown; an attempt is journaled before file writes/launch and is never automatically resent. Actual model launch and report return have **not** been observed end to end.

### Existing-session limitation

Existing sessions are discovered but returned with `sendable: false`. Orca 1.4.250 and inspected upstream 1.4.252 have no atomic idle-only check in the terminal submission critical section. `agents.list` followed by send races with human/agent input. A prompt hook cannot repair this: its asynchronous decision precedes submission, lacks authoritative activity state, and does not serialize human input. Waiting for permission is not idle.

Required upstream contract: check authoritative idle state, process incarnation, and permissions **immediately before PTY input inside native submission**, including remote execution, and return an explicit refusal receipt if conditions changed. There is no unsafe precheck/send fallback or hidden queue.

Primary native sources:

- [Host API workspace methods: `TEXT_MAX`, `agent.launch`](https://github.com/stablyai/orca/blob/v1.4.250/src/shared/plugins/workers/plugin-host-api-workspace-methods.ts): the Host API prompt is limited to 4,096 JS code units and has no `env`, `model`, or `effort` fields. The implementation uses the native CLI rather than treating this launch API as a delivery receipt.
- [Launch binding](https://github.com/stablyai/orca/blob/v1.4.250/src/main/plugins/workers/plugin-host-workspace-method-bindings.ts), [terminal binding](https://github.com/stablyai/orca/blob/v1.4.250/src/main/plugins/workers/plugin-host-method-bindings.ts), [initial prompt handling](https://github.com/stablyai/orca/blob/v1.4.250/src/main/runtime/rpc/methods/agent-launch-terminal-prompt.ts), and [events](https://github.com/stablyai/orca/blob/v1.4.250/src/shared/plugins/events/plugin-events.ts).
- [1.4.252 terminal prompt submission](https://github.com/stablyai/orca/blob/v1.4.252/src/main/runtime/terminal/input/terminal-agent-prompt.ts) and [input admission](https://github.com/stablyai/orca/blob/v1.4.252/src/main/runtime/terminal/input/terminal-input-admission.ts); installed native CLI/help and submission source inspection are recorded in [workflow](workflow.md).

## Claim, documents, and report trust

Dispatch does not reserve, Claim, or close tasks. Each handoff declares a distinct `beads-orca-<UUID>` actor and instructs the executor to Claim in the **source** directory before ready work, preserve other owners, and stop when no independent work remains. This is a declared string, not authenticated identity or enforcement. The panel's manual Claim still uses the CLI process actor. A native atomic Claim is not an atomic readiness check of the entire dependency graph; expiry of a lease is not evidence that an agent stopped. The [core routing race](../src/core/README.md) also remains: exact-ID precheck and mutation are separate native processes.

- [Native Claim](https://github.com/gastownhall/beads/blob/v1.3.2/internal/storage/issueops/claim.go), [actor comparison](https://github.com/gastownhall/beads/blob/v1.3.2/internal/storage/issueops/identity.go), [lease behavior](https://github.com/gastownhall/beads/blob/v1.3.2/internal/storage/issueops/lease.go).

Linked/manual Markdown is confined to the chosen workspace; no home/repository scan or execution of document commands occurs. Descriptor-anchored file operations reject traversal and symlinks. Text reads/writes are capped at **2 MiB**, while serialized library responses are capped at **768 KiB**, so a file below the disk limit can still be too large to preview. Native editor open checks metadata without reading text and has no such text-size cap. **`editor.open` is path-only: a malicious replacement between inspection and native open remains a TOCTOU race**, not a sandbox guarantee.

Long prompts above 3,500 JS code units use explicit `.beads-orca/handoffs/<UUID>/context.md` on the target; the executor writes `report.json` beside it. Reports validate identity and every selected task exactly once. Outcome/check text is an executor's report, not independently verified execution. `comparisonBase: null` means attribution is unknown. Human review owns integration and closing; publication sends concise selected-task comments, not full private context. Cleanup is explicit and limited to those artifact files, never branches/worktrees or code changes.

Imported history is permanently unverified and inert: no dispatch, report-file read, reported-file navigation, Beads publication, or cleanup from imported records. Its contents can include complete task/document context; review exports before sharing. History deletion does not delete artifacts or undo agent work.

## Storage and RPC limits

Native storage allows **256 KiB per value / 5 MiB total**, shared by history, snapshot caches, and personal filters. History chunks immutable context, reserves receipt space before effects, and rejects capacity failures without eviction or truncation. Serialized handoff context is bounded to 512 KiB; mutable receipt/report metadata to 240 KiB. Explicit project-filter publication writes `.beads-orca/filters.json` with portable names, no commit/push; disclosure checks are not a secret scanner.

The [native panel bridge](https://github.com/stablyai/orca/blob/v1.4.250/src/shared/plugins/workers/plugin-panel-bridge-protocol.ts) permits 64 KiB input, 1 MiB response, and 256 KiB unsolicited posts. Default request deadline is 30 seconds, maximum 120 seconds. Starting with 0.2.1, every panel call uses a versioned request envelope. Replies up to 512 KiB return inline; larger replies are reconstructed from chunks of at most 65,536 UTF-16 code units (under 400 KiB even with worst-case JSON escaping). The native input limit still includes envelope overhead.

The transfer store bounds each serialized result to 32 MiB, retained UTF-16 text to 64 MiB, and active transfers to eight per worker. UUID request/transfer identities and sequential indexes prevent crossed or reordered replies. A 120-second absolute lifetime includes application work. Completion, failure, cancellation and panel teardown release transfers; expiry covers lost cleanup. Cancelled pending work keeps its admission slot until settling. Limits produce explicit errors, never truncated snapshots. Application requests are not automatically retried: cancellation or timeout does not prove that a mutation did not run.

History retains its paged export/chunked import contract. Source: [worker transfer store](../src/orca/reply-transfer.ts), [panel transport](../src/orca/panel-transport.ts), [shared limits](../src/orca/transfer-protocol.ts). Detailed application paging contracts are in [workflow](workflow.md).

## Worktrees and verification limits

Native `worktree create` is previewed and explicit, uses `--no-parent --setup skip`, and requests no agent. Native default tabs may still open; returned identity/branch is authoritative if Orca suffixes a name. No database copy, automatic worktree removal, merge, rebase, or push occurs. Real isolated worktree preview/create was observed; this is not an observed model launch.

Native Orca UI on macOS, real paired-runtime behavior and actual model execution remain unverified. CI does not establish those behaviors or remove the native idle-only restriction.

Historical alternatives and upstream context:

- [Host API](https://github.com/stablyai/orca/blob/v1.4.250/docs/reference/plugin-host-api.md) has no general remote file/exec API. [Remote-worker request](https://github.com/stablyai/orca/issues/37788) and [paired workspace-list report](https://github.com/stablyai/orca/issues/30852) are upstream reports, not reproduced defects here.
- [`bd serve`](https://github.com/gastownhall/beads/blob/9b65b9e198acbcc98e7fd3a87a5d55baa065a572/cmd/bd/serve.go) and its [HTTP API](https://github.com/gastownhall/beads/blob/9b65b9e198acbcc98e7fd3a87a5d55baa065a572/internal/httpapi/spec/openapi.v0.yaml) were not selected: embedded Dolt restrictions and HTTP hook/auto-commit differences prevent treating them as a transparent native-CLI replacement.
