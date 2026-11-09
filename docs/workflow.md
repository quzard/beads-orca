# Workflow service contract

This document describes the plugin's workflow API and safety boundaries. Existing-session dispatch remains unavailable without the native idle-only requirement below. See [configuration and trust limits](integration-constraints.md).

`src/orca/workflow.ts` supplies the worker-owned `WorkflowService(host, access, library)` instance. `WorkflowInputs`, `WorkflowResults`, and the discriminated `WorkflowRequest` are exported from `src/orca/workflow-types.ts`. All project/target inputs are **Project.id**, not filesystem paths or native CLI selectors. The service resolves the registered native workspace and execution host itself.

## Preview and dispatch

- `agents.list` discovers terminal-backed sessions in the selected native workspace, joining native `worktree ps` pane identities to `terminal list` handles. Provider choices are the supported CLI providers actually found on the target host's PATH: Claude, Codex, OMP, Pi, Grok, Gemini, OpenCode, Amp, Aider, Goose, and Copilot. These IDs were checked against the installed native provider registry, including Amp, Aider, and Goose; the CLI exposes no provider-catalog API. Executable presence does **not** prove authentication, configuration, billing access, or readiness to accept work. A running agent type is not proof that its executable is installed for a new launch.
- `handoff.preview` accepts explicitly grouped task references, one source Beads project and one target workspace per group. A task cannot occur in two groups in the same request. Implementation and research are distinct choices. External blockers require adding the blocker, removing the dependent task, or explicitly choosing research. Internal blockers remain visible and require live Beads readiness; cycles are refused for implementation.
- The preview includes full issue fields/versions, selected document contents/hashes, blocker relationships, host/workspace, a unique declared actor, the complete prompt, the actual transport prompt, and exact artifact paths. It is saved as a private draft; no file or agent is created during preview.
- `handoff.send` accepts only a locally created draft ID. It re-reads source tasks, readiness, documents, provider availability, native target identity, and access mappings. Material changes require a new preview. It does not silently replace the previewed prompt.
- Dispatch never claims or closes tasks. Instructions require `bd --actor beads-orca-<UUID> update --claim -- <task-id>` in the original source Beads directory, preserve another executor's ownership, forbid forced reclaim and automatic integration, and require a report. Instructions are not authenticated identity or enforcement of agent behavior.
- Context longer than 3,500 JavaScript code units is written in full to `.beads-orca/handoffs/<UUID>/context.md` on the target. The native launch receives a short instruction to read that exact file. No repository scan, hidden document inclusion, truncation, automatic Git staging, or database copying occurs.
- The source database and target executor must be on the same execution host. Desktop access to two hosts does not give an agent on one host credentials to the other. Cross-host groups receive an explicit preview error rather than copying the database or assuming agent access.

### Explicit document fragments

`DocumentRef` and preview document records accept optional `startLine` and `endLine`. Omit both to include the whole file, unchanged from the whole-document behavior. When specified, both must be positive safe integers with `startLine <= endLine <=` the live file's line count. Bounds are **1-based and inclusive**, never clipped. For example, `{project: "<Project.id>", path: "docs/design.md", startLine: 10, endLine: 24}` explicitly selects those lines.

Lines are LF-delimited and selected text preserves the original LF/CRLF terminators. A final LF does not create a phantom extra line; an empty file has no selectable lines. The preview, group, private history, and export retain the bounds. Document `text` contains only the selected lines, while `hash` identifies the **full original file**, so a change outside the selected excerpt also invalidates the approved preview. Selecting an excerpt does not bypass full-file read limits.

In the prepared 0.2.2 UI, a Markdown tile's primary action is `documents.open`: validate the registered workspace and confined path, then call native `editor.open`. There is no browser fallback. Preview reads contents separately; Include selects handoff context separately. Three tiles are initially visible; Show more reveals the rest. Manual project-relative paths offer Open in Orca first. No repository scan or agent-assisted link suggestion is performed.

After **Preview**, the UI offers optional **First/Last** line inputs and retains the explicit inclusion checkbox. Invalid included ranges show inline errors and prevent handoff preview; nothing is silently included or shortened. Imports validate paired bounds, excerpt line span, and agreement with the group. They cannot verify the original source/hash offline and remain inert, unverified archives.

### Saved epic filters

The optional filter field is `epic: {id: string | null, projectName: string, hostName: string}`. Omission means all epics; `id: null` means verified no epic. A string selects that epic and its parent-child descendants, including the clearly typed epic row. Missing parents do not imply No epic; traversal is cycle-safe.

Applying a saved epic requires exactly one registered project matching both portable names. Missing or ambiguous matches are refused rather than applying a task ID to another database. Explicit project changes clear the epic. Existing saved filters without the field retain their meaning; the storage format remains version 1. Status views use Table without overwriting All issues' stored layout.



### Actionable stale-preview rejection

Send compares freshly read context with the stored preview fingerprint. A mismatch rejects the draft with changed categories and useful task IDs/document paths where available: **Issues**, **Documents**, **Recipient**, **Workspace**, **Dependencies**, and **Readiness/Eligibility**. Optional stored revalidation details cover native workspace identity, dependency hashes, readiness, and provider availability. Older history without those details stays readable; diagnostics disclose when comparison detail is unavailable.

The approved prompt is not replaced. A known stale mismatch is saved as **rejected**, shown as such in the UI, and requires an explicit new preview even if the original context later returns. It is not labeled unknown delivery; actual transport ambiguity still is. Revalidation does not atomically freeze Beads, documents, or sessions, so executors must still check live state before work.

### Native transport and unresolved existing-session requirement

New sessions use `orca agent launch --surface terminal` with structured `execFile` arguments and an explicit target. Local and SSH targets use the desktop runtime. Orca 1.4.250 rejects `--host` on `agent launch`, so an SSH handoff passes only the worktree id and continues only when `worktree show` reports that same SSH host and path. SSH worktree creation uses `worktree create --project <id> --host ssh:…` after `project setups`, because `--host` is valid there only together with `--project`. Explicitly mapped paired targets still use `--environment <environment-id>` and a server-side selector. Unmapped remote hosts remain unavailable through `ProjectAccess`; real paired-runtime execution is unverified. The CLI child removes inherited `ELECTRON_RUN_AS_NODE`, `ORCA_PAIRING_CODE`, and `ORCA_ENVIRONMENT` and preserves the configured CLI executable. Although the child wrapper preserves `ORCA_USER_DATA_PATH` if present, native worker startup strips it first: observed CLI discovery uses the standard HOME profile. The isolated fixture exposed its own profile at `HOME/.config/orca`; custom nondefault-profile dispatch is not supported/proven. Successful stdout is parsed independently of diagnostic stderr, and structured CLI refusal envelopes are retained.

A terminal handle or generic `accepted` response is not proof of prompt delivery. Only the native launch receipt's `prompt.outcome` (`journaled` or `handed-to-terminal`) is recorded as that specific delivery state. Raw receipt metadata and ambiguous error receipts are retained. No automatic launch/send retry occurs. The private history is persisted as `unknown` **before** a context-file write or agent launch; a crash cannot turn an attempted dispatch back into an executable draft. Reusing a sent or ambiguous ID is refused; re-send starts with a new preview.

**Existing-session dispatch is intentionally unavailable, not implemented with a precheck.** Installed Orca 1.4.250 has durable terminal-send request IDs, replay, and `turn_started` observations, but does not atomically reject a working agent. Upstream tag 1.4.252 still checks permission state, liveness, and process incarnation rather than an idle-only condition immediately before input. A serialized plugin prompt hook does not solve this: its payload has no authoritative activity state, its asynchronous decision precedes the actual submission critical section, and human input bypasses that hook order.

Minimum upstream fix: an idle-only conditional on native terminal send, checked against authoritative activity, permissions, and process incarnation in the actual submission critical section immediately before PTY input, with an explicit refusal receipt and remote-host support. Until that exists, discovered sessions expose `sendable: false` and explain how to choose a new session.

Primary sources inspected without agent launch:

- Version-matched installed `orca-ide skills get orca-cli --json`, `terminal send --help`, `agent launch --help`, `worktree create --help`.
- Installed `/opt/stably-orca/resources/orcad-template/orcad-server.js`: `writeTerminalAgentPrompt`, `sendTerminalAgentPrompt`, hook ordering, and `agent.prompt.before` schema.
- [1.4.252 terminal-agent-prompt.ts](https://github.com/stablyai/orca/blob/v1.4.252/src/main/runtime/terminal/input/terminal-agent-prompt.ts).
- [1.4.252 terminal-input-admission.ts](https://github.com/stablyai/orca/blob/v1.4.252/src/main/runtime/terminal/input/terminal-input-admission.ts).

## Private history and transfer

`history.get`, `history.list`, selective `history.export`, `history.import`, and `history.delete` operate only on plugin-private storage. Deleting history does not remove artifacts, tasks, branches, or agent changes. Draft deletion is not cancellation of a running agent. Session stop remains a separate native Orca action.

Native storage permits 256 KiB per value and 5 MiB total shared with snapshot caches and filters. History uses immutable context chunks, an index, and small per-entry mutable records. A receipt reservation is allocated while still a draft. Capacity failures are explicit; there is no eviction or context truncation. The context preview is limited to 512 KiB serialized UTF-8, and mutable metadata/report/receipt to 240 KiB including its reservation, leaving room below the native response ceiling. Oversized imports/reports are refused without replacing the previously stored entry.

Native [panel bridge limits](https://github.com/stablyai/orca/blob/v1.4.250/src/shared/plugins/workers/plugin-panel-bridge-protocol.ts) are 64 KiB input, 1 MiB response, 256 KiB unsolicited post, with a 30-second default request deadline and 120-second maximum. The UI must use the longer supported deadline for workflow actions and never interpret a timeout as guaranteed non-delivery.

- `history.list({offset?,limit?})` returns `{entries,nextOffset}`. Offsets count entries; limits are 1–100 (default 20). Each response is additionally capped at 900 KiB. Follow `nextOffset` to list the complete history.
- `history.export({ids,offset?,hash?})` returns `{version:1,text,nextOffset,hash}`. Start with omitted/zero offset. Concatenate `text` in order and parse/save the resulting `HistoryExport` JSON only after `nextOffset === null`. Offsets count UTF-16 code units, not bytes. Repeat the selected IDs and returned hash on every subsequent page; concurrent changes are rejected rather than producing a mixed export. Export text pages contain at most 32,000 code units.
- The exported JSON explicitly warns that it contains complete prompts and selected document contents.
- Small programmatic imports can use `history.import({data})`. The panel uses `history.import.begin({}) -> {id}`, sequential `history.import.chunk({id,text}) -> {received}`, and `history.import.finish({id}) -> {imported,skipped}`. Input chunks contain at most 8,192 code units. Partial uploads never alter history. Finishing validates the complete export; duplicate existing IDs are skipped, not overwritten. Failed finishes discard their buffer. At most four uploads can be buffered, each bounded to 5 MiB; abandoned uploads expire after 15 minutes.
- Imported entries are permanently marked `imported: true`. Their receipts/reports are unverified archival claims, not evidence of a local native operation. They cannot dispatch, read a recorded report path, navigate reported changes, clean artifacts, or publish to a local database. A new preview is required to reuse their task selection.

## Reports and explicit artifact lifecycle

The executor writes `.beads-orca/handoffs/<UUID>/report.json`. `handoff.report` reads that exact target-host file and validates version, handoff identity, and every selected task exactly once. Missing, foreign, or duplicate task IDs fail validation. Outcomes are per-task `completed`, `partial`, `blocked`, or `not-started`, with summaries, changes, and reported check results. Missing reports or an empty check list are not verification. Validation checks structure and association, not whether the executor actually ran those checks or completed the work; humans review the report and changes. `comparisonBase: null` explicitly means change attribution is unknown.

`changes[]` contains normalized target-workspace-relative file paths. Absolute paths, traversal, URLs, and backslash paths are rejected; commit references belong in the summary. `handoff.openChange({id,path})` opens only a path explicitly present in a loaded native report. It uses `ProjectAccess.inspectFile` against the captured target identity, without reading file content, and rechecks the access mapping and live native workspace ID/path/host before calling `editor.open`. Missing/deleted files, unreported paths, imported records, changed workspace bindings, and native editor refusals produce explicit errors. Navigation never executes, merges, or otherwise changes the reported file.

Document and reported-file opening use metadata-only inspection, without a text-size cap. The final native `editor.open` accepts only a path, not the inspected descriptor: malicious replacement between inspection and open remains a TOCTOU risk. Confined text operations require POSIX semantics and `python3` on the workspace host and cap reads/writes at 2 MiB; library JSON replies have a lower 768 KiB cap. SSH configuration and same-host execution prerequisites are documented in [integration constraints](integration-constraints.md).

`history.publish` requires a loaded report and an explicit task-ID selection. It publishes only concise per-task reports as Beads comments, never the full prompt/documents, and does not close tasks. Each publication attempt is recorded as unknown before the comment write; an ambiguous result is not automatically repeated. Partial publication remains visible.

`handoff.cleanup` accepts only the fixed context/report paths derived from the native handoff UUID. It never accepts imported artifact paths or arbitrary code paths, and never deletes directories, branches, or worktrees. History deletion and artifact cleanup are separate explicit operations. File operations and publication pin the original `ProjectIdentity`, including the explicit SSH mapping fingerprint; a changed path/host/workspace/mapping is rejected. External edits to the contents of an SSH config file cannot be detected from its path fingerprint.

## Explicit native worktree creation

`worktree.preview` resolves the registered Git workspace and previews name, branch, base choice, host, exact argv, and native behavior warnings. `worktree.create` revalidates the source identity, persists an unknown operation first, then invokes native `worktree create` with `--no-parent --setup skip` and no requested agent. Native configured default tabs can still open, and Orca may suffix an occupied branch name; the returned native identity is authoritative. The plugin neither copies Beads data nor automatically deletes the new worktree. A repeated operation ID returns its existing result instead of running creation again.

## Verification boundaries

Public seams are `WorkflowService.request`, the native CLI boundary, report/import validation, and native private storage. Deterministic coverage includes preview freshness, document/mapping changes, blockers, disabled unsafe existing-session delivery, ambiguous launch/no retry, quota-before-effects, chunked history round-trip, imported-history safety, explicit report publication/cleanup, confined reported-file navigation without content reads, native worktree intent, host routing, and bounded paging. These unit tests do not launch real agents or write a real Beads database.

Actual model execution, native Orca UI on macOS and real paired-runtime behavior remain unverified. Unit tests and provider discovery do not establish an end-to-end model/report round trip.
