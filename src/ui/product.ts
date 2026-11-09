import type { Issue, Project, Snapshot, Transport } from '../shared.js';
import type { DocumentLink, DocumentOpenResult, DocumentResult, FilterCriteria, FilterListResult, SavedFilter } from '../orca/library.js';
import type { AgentDiscovery, HandoffGroup, HandoffPreview, HistoryEntry, HistoryExport, WorktreePreview, WorkflowInputs, WorkflowMethod, WorkflowResults } from '../orca/workflow-types.js';
import { documentLines, documentRange } from '../orca/workflow-validation.js';
import { deliveryLabel, modeLabel, outcomeLabel, scopeLabel, syncPanelLocale, t } from './i18n.js';
import { icon } from './icons.js';

type PoolItem = { project: string; id: string; title: string };
type DraftGroup = { key: number; project: string; tasks: PoolItem[]; target: string; kind: 'new' | 'existing'; recipient: string; mode: 'implementation' | 'research' };
type Panel = 'handoff' | 'history' | 'filters' | 'worktree' | 'hosts' | null;
type Context = {
  root: HTMLElement;
  transport: Transport;
  projects(): Project[];
  projectId(): string;
  issueId(): string;
  snapshot(): Snapshot | null;
  pool(): PoolItem[];
  currentUnavailable(): boolean;
  projectAvailability(project: Project): string;
  addTask(item: PoolItem): void;
  removeTask(project: string, id: string): void;
  criteria(): FilterCriteria;
  applyCriteria(criteria: FilterCriteria): void;
  selectProject(id: string): void;
  reloadProjects(): void;
  render(): void;
};

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
const selected = (left: string, right: string): string => left === right ? ' selected' : '';

function confirmProductAction(message: string): Promise<boolean> {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog product-confirm';
  dialog.setAttribute('aria-labelledby', 'product-confirm-heading');
  dialog.setAttribute('aria-describedby', 'product-confirm-message');
  dialog.innerHTML = `<form method="dialog"><header class="dialog__header"><h2 id="product-confirm-heading">${t("Confirm action", "确认操作")}</h2></header><div class="dialog__body"><p id="product-confirm-message"></p></div><footer class="dialog__actions"><button class="btn btn--text" value="cancel" autofocus>${t("Cancel", "取消")}</button><button class="btn btn--primary" value="confirm">${t("Confirm", "确认")}</button></footer></form>`;
  dialog.querySelector('#product-confirm-message')!.textContent = message;
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  const { promise, resolve } = Promise.withResolvers<boolean>();
  dialog.addEventListener('close', () => {
    const confirmed = dialog.returnValue === 'confirm';
    dialog.remove();
    const parent = document.querySelector<HTMLDialogElement>('[data-product-dialog]');
    if (parent && !parent.open) parent.showModal();
    resolve(confirmed);
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return promise;
}

export function createProductUI(context: Context) {
  let panel: Panel = null;
  let busy = false;
  let error = '';
  let notice = '';
  let groups: DraftGroup[] = [];
  let nextGroup = 1;
  let previews: HandoffPreview[] = [];
  let sent = new Map<string, HistoryEntry>();
  const uncertain = new Set<string>();
  const discoveries = new Map<string, AgentDiscovery>();
  const included = new Set<string>();
  const documentLinks = new Map<string, DocumentLink[]>();
  const documentVersions = new Map<string, string>();
  const documentResults = new Map<string, DocumentResult>();
  const documentRanges = new Map<string, { startLine: string; endLine: string }>();
  const manualDocuments = new Map<string, Set<string>>();
  const documentStatus = new Map<string, string>();
  const documentErrors = new Map<string, string>();
  const documentsLoading = new Set<string>();
  const expandedDocuments = new Set<string>();
  let manualPath = '';
  let filters: FilterListResult = { personal: [], project: [] };
  let filterName = '';
  const filterProjectNames = new Set<string>();
  const filterHostNames = new Set<string>();
  let history: HistoryEntry[] = [];
  let historyNext: number | null = null;
  const historySelection = new Set<string>();
  let historyId = '';
  let historyData = '';
  const cleanupPaths = new Set<string>();
  const publishTasks = new Set<string>();
  const uncertainPublications = new Set<string>();
  let worktreeName = '';
  let worktreeBranch = '';
  let worktreeBase = '';
  let worktree: WorktreePreview | null = null;
  let worktreeResult = '';
  let sshReport = '';

  function isUnavailable(projectId: string): boolean {
    const current = context.snapshot();
    const project = current?.project.id === projectId ? current.project : context.projects().find((item) => item.id === projectId);
    return !project || (projectId === context.projectId() && context.currentUnavailable()) || project.availability === 'offline' || project.availability === 'unsupported';
  }

  async function workflow<K extends WorkflowMethod>(method: K, input: WorkflowInputs[K]): Promise<WorkflowResults[K]> {
    return context.transport.request<WorkflowResults[K]>({ method, input: input as unknown as Record<string, unknown> });
  }

  async function run(operation: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true; error = ''; notice = ''; context.render();
    try { await operation(); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; context.render(); }
  }

  function projectName(id: string): string {
    const project = context.projects().find((item) => item.id === id);
    return project ? `${project.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || project.name} · ${project.workspaceId ? project.name : t("Additional path", "附加路径")} · ${project.hostName || project.hostId || t("Local", "本机")}` : id;
  }

  function projectStatus(id: string): string {
    const project = context.projects().find((item) => item.id === id);
    return `${projectName(id)}${project?.path ? ` · ${project.path} · ${context.projectAvailability(project)}` : ''}`;
  }

  function portableHostName(project: Project): string {
    if (!project.hostId || project.hostId === 'local') return project.hostName || t("Local", "本机");
    return project.hostName && project.hostName !== project.hostId ? project.hostName : '';
  }

  function resetGroups(): void {
    const pool = context.pool();
    const tasks = new Map<string, PoolItem>(pool.map((item) => [`${item.project}\0${item.id}`, item]));
    const projects = new Set(pool.map((item) => item.project));
    groups = groups.filter((group) => projects.has(group.project));
    for (const group of groups) group.tasks = group.tasks.flatMap((item) => {
      const latest = tasks.get(`${item.project}\0${item.id}`);
      if (!latest) return [];
      tasks.delete(`${item.project}\0${item.id}`);
      return [latest];
    });
    for (const item of tasks.values()) {
      let group = groups.find((candidate) => candidate.project === item.project);
      if (!group) {
        group = { key: nextGroup++, project: item.project, tasks: [], target: item.project, kind: 'new', recipient: '', mode: 'implementation' };
        groups.push(group);
      }
      group.tasks.push(item);
    }
    previews = []; sent = new Map(); uncertain.clear();
  }

  async function discover(target: string): Promise<void> {
    if (!target || discoveries.has(target)) return;
    const result = await workflow('agents.list', { target });
    discoveries.set(target, result);
    for (const group of groups.filter((item) => item.target === target && !item.recipient)) group.recipient = result.providers[0]?.id || '';
  }
  async function loadFilters(): Promise<void> {
    const project = context.currentUnavailable() ? undefined : context.projectId() || undefined;
    if (!project) {
      filters = await context.transport.request<FilterListResult>({ method: 'filters.list' });
      notice = t("Project filters are unavailable offline; personal filters are shown.", "离线时没有项目筛选，只显示个人筛选。");
      return;
    }
    try {
      filters = await context.transport.request<FilterListResult>({ method: 'filters.list', project });
    } catch (reason) {
      filters = await context.transport.request<FilterListResult>({ method: 'filters.list' });
      notice = t('Project filters could not be read: {reason}. Personal filters are shown.', '项目筛选读不到：{reason}。只显示个人筛选。', { reason: reason instanceof Error ? reason.message : String(reason) });
    }
  }
  async function loadHistory(offset = 0): Promise<void> {
    const page = await workflow('history.list', { offset });
    if (offset === 0) history = page.entries;
    else {
      const existing = new Set(history.map((entry) => entry.id));
      history.push(...page.entries.filter((entry) => !existing.has(entry.id)));
    }
    historyNext = page.nextOffset;
  }



  async function open(next: Exclude<Panel, null>): Promise<void> {
    panel = next; error = ''; notice = '';
    if (next === 'handoff') {
      discoveries.clear(); resetGroups(); context.render();
      await run(async () => { for (const target of new Set(groups.map((group) => group.target))) if (!isUnavailable(target)) await discover(target); });
    } else if (next === 'history') {
      historyId = ''; historySelection.clear(); historyData = ''; history = []; historyNext = null; context.render();
      await run(() => loadHistory());
    } else if (next === 'filters') {
      const criteria = context.criteria();
      filterProjectNames.clear(); filterHostNames.clear();
      for (const name of criteria.projectNames) filterProjectNames.add(name);
      for (const name of criteria.hostNames) filterHostNames.add(name);
      context.render();
      await run(loadFilters);
    } else { context.render(); if (next === 'hosts') context.reloadProjects(); }
  }

  function controls(): string {
    return `<button class="btn btn--outlined btn--sm" type="button" data-product-action="handoff"${context.pool().length ? '' : ' disabled'}>${t("Handoff", "交接")}${context.pool().length ? ` (${context.pool().length})` : ''}</button><details class="workflow-menu" data-persist="workflow-menu"><summary class="btn btn--text btn--sm" data-focus="workflows">${t("Workflows", "工作流")}${icon('arrow_drop_down')}</summary><div class="workflow-menu__panel" aria-label="${t("Workflows", "工作流")}"><button class="btn btn--text btn--sm" type="button" data-product-action="filters">${t("Saved filters", "已保存的筛选")}</button><button class="btn btn--text btn--sm" type="button" data-product-action="history">${t("History", "历史")}</button><button class="btn btn--text btn--sm" type="button" data-product-action="worktree"${context.projectId() ? '' : ' disabled'}>${t("Worktree", "Worktree")}</button><button class="btn btn--text btn--sm" type="button" data-product-action="hosts">${t("Hosts", "主机")}</button></div></details>`;
  }

  async function loadDocuments(project: string, issue: string, version = ''): Promise<void> {
    const key = `${project}\0${issue}`;
    if ((documentLinks.has(key) && documentVersions.get(key) === version) || documentsLoading.has(key)) return;
    documentsLoading.add(key); documentErrors.delete(key); context.render();
    try {
      const links = await context.transport.request<DocumentLink[]>({ method: 'documents.list', project, input: { id: issue } });
      documentLinks.set(key, links);
      documentVersions.set(key, version);
    } catch (reason) { documentErrors.set(key, reason instanceof Error ? reason.message : String(reason)); }
    finally { documentsLoading.delete(key); context.render(); }
  }

  function selectedDocumentRange(key: string) {
    const draft = documentRanges.get(key);
    if (!draft || (!draft.startLine && !draft.endLine)) return {};
    const file = documentResults.get(key);
    if (!file) throw new Error(t("Read the document before selecting a line range.", "先预览文档再选行。"));
    return documentRange({
      path: file.path,
      startLine: draft.startLine ? (/^\d+$/.test(draft.startLine) ? Number(draft.startLine) : NaN) : undefined,
      endLine: draft.endLine ? (/^\d+$/.test(draft.endLine) ? Number(draft.endLine) : NaN) : undefined,
    }, documentLines(file.text).length);
  }

  function documentRangeFields(project: string, path: string): string {
    const key = `${project}\0${path}`, file = documentResults.get(key);
    if (!file) return '';
    const range = documentRanges.get(key) ?? { startLine: '', endLine: '' };
    let rangeError = '';
    try { selectedDocumentRange(key); } catch (reason) { rangeError = reason instanceof Error ? reason.message : String(reason); }
    const errorId = `document-range-${encodeURIComponent(path)}`;
    return `<div class="dialog__row">${(['startLine', 'endLine'] as const).map((bound) => `<label class="field">${bound === 'startLine' ? t("First", "起始") : t("Last", "结束")}${t(" line (optional)", "行（可选）")}<input type="text" inputmode="numeric" data-product-input="document-range" data-bound="${bound}" data-path="${escape(path)}" value="${escape(range[bound])}"${rangeError ? ` aria-invalid="true" aria-describedby="${escape(errorId)}"` : ''}></label>`).join('')}</div><p class="muted">${documentLines(file.text).length}${t(" lines. Leave both blank for the whole file, or enter inclusive first and last lines. Check the document to include it.", " 行。都留空表示整个文件，或填写起止行（含两端）。勾选后才会放进交接。")}</p>${rangeError ? `<p class="detail__error" role="alert" id="${escape(errorId)}">${escape(rangeError)}</p>` : ''}`;
  }

  function documents(issue: Issue): string {
    const project = context.projectId();
    const key = `${project}\0${issue.id}`;
    const links = documentLinks.get(key) || [];
    const manual = [...(manualDocuments.get(project) || [])].filter((path) => !links.some((link) => link.path === path));
    const rows = [...links.map((link) => ({ path: link.path, label: link.label, source: link.source })), ...manual.map((path) => ({ path, label: path, source: 'manual' }))];
    const expanded = expandedDocuments.has(key);
    const visible = expanded ? rows : rows.slice(0, 3);
    const disabled = busy || isUnavailable(project) ? ' disabled' : '';
    return `<section class="detail__section"><h3>${t("Documents", "文档")}</h3><p class="muted">${t("Open a document in Orca. Preview and check it to include its contents in a handoff.", "在 Orca 中打开文档。预览并勾选后，才会把内容放进交接。")}</p>${isUnavailable(project) ? `<p class="muted">${t("Offline: previously loaded document contents may be out of date.", "离线：之前加载的文档内容可能已过期。")}</p>` : ''}
      ${documentsLoading.has(key) ? `<p class="muted" role="status">${t("Loading document links…", "正在加载文档链接…")}</p>` : ''}${documentStatus.has(key) ? `<p class="muted" role="status">${escape(documentStatus.get(key))}</p>` : ''}${documentErrors.has(key) ? `<p class="detail__error" role="alert">${escape(documentErrors.get(key))} <button type="button" class="btn btn--text btn--sm" data-product-action="documents-retry" data-id="${escape(issue.id)}">${t("Retry", "重试")}</button></p>` : ''}
      ${rows.length ? `<div class="document-grid">${visible.map((row) => {
        const name = row.path.split('/').pop() || row.path;
        return `<div class="document-tile"><button type="button" class="document-tile__open" data-product-action="document-open" data-path="${escape(row.path)}" aria-label="${escape(t('Open {path} in Orca', '在 Orca 中打开 {path}', { path: row.path }))}" title="${escape(row.path)}"${disabled}><span class="document-tile__icon">${icon('description')}</span><span class="document-tile__name">${escape(name)}</span><span class="document-tile__path">${escape(row.path)}</span></button><div class="document-tile__actions"><label class="check"><input type="checkbox" data-product-change="include-document" data-path="${escape(row.path)}" aria-label="${escape(t('Include {path} in handoff', '把 {path} 放进交接', { path: row.path }))}"${included.has(`${project}\0${row.path}`) ? ' checked' : ''}>${t("Include", "包含")}</label><button type="button" class="btn btn--text btn--sm" data-product-action="document-read" data-path="${escape(row.path)}" aria-label="${escape(t('Preview {path}', '预览 {path}', { path: row.path }))}"${disabled}>${t("Preview", "预览")}</button></div></div>`;
      }).join('')}</div>${rows.length > 3 ? `<button type="button" class="btn btn--text btn--sm" data-product-action="documents-expand" aria-expanded="${expanded}">${expanded ? t('Show fewer', '收起') : t('Show {n} more', '还有 {n} 条', { n: rows.length - 3 })}</button>` : ''}${visible.filter((row) => documentResults.has(`${project}\0${row.path}`)).map((row) => `<section class="document-preview" aria-label="${escape(t('Preview {path}', '预览 {path}', { path: row.path }))}"><h4>${escape(row.path)}</h4>${documentRangeFields(project, row.path)}<pre class="command product-content">${escape(documentResults.get(`${project}\0${row.path}`)?.text)}</pre></section>`).join('')}` : isUnavailable(project) ? `<p class="muted">${t("Document links are unavailable offline.", "离线时无法加载文档链接。")}</p>` : `<p class="muted">${t("No linked Markdown documents. Add a project-relative path below.", "没有关联的 Markdown 文档。在下面添加相对项目的路径。")}</p>`}
      <div class="dependency-form"><label>${t("Relative Markdown path", "相对 Markdown 路径")}<input data-product-input="manual-path" value="${escape(manualPath)}" placeholder="docs/plan.md"></label><button type="button" class="btn btn--outlined btn--sm" data-product-action="document-open-manual"${busy || isUnavailable(project) || !manualPath.trim() ? ' disabled' : ''}>${t("Open in Orca", "在 Orca 中打开")}</button><button type="button" class="btn btn--text btn--sm" data-product-action="document-add"${busy || isUnavailable(project) || !manualPath.trim() ? ' disabled' : ''}>${t("Preview", "预览")}</button></div></section>`;
  }

  function handoffBody(): string {
    const projects = context.projects();
    const grouped = groups.map((group) => {
      const discovery = discoveries.get(group.target);
      const recipients = group.kind === 'new' ? (discovery?.providers || []).map((provider) => ({ value: provider.id, label: provider.name, disabled: false })) : (discovery?.sessions || []).map((session) => ({ value: session.terminal, label: `${session.agent} · ${session.terminal} · ${session.state}${session.reason ? ` — ${session.reason}` : ''}`, disabled: !session.sendable }));
      const siblingGroups = groups.filter((item) => item.project === group.project);
      const locked = busy ? ' disabled' : '';
      return `<section class="product-section"><div class="product-section__head"><h3>${escape(projectStatus(group.project))} · ${t("Group ", "分组 ")}${siblingGroups.indexOf(group) + 1}</h3><button type="button" class="btn btn--text btn--sm" data-product-action="add-group" data-group="${group.key}"${locked}>${t("Split group", "拆分分组")}</button></div>
        ${group.tasks.length ? `<ul class="product-list">${group.tasks.map((task) => `<li><span>${escape(task.id)} · ${escape(task.title)}</span><label class="field">${t("Group", "分组")}<select data-product-change="task-group" data-group="${group.key}" data-id="${escape(task.id)}"${locked}>${siblingGroups.map((candidate, index) => `<option value="${candidate.key}"${selected(String(group.key), String(candidate.key))}>${t('Group {n}', '分组 {n}', { n: index + 1 })}</option>`).join('')}</select></label><button type="button" class="btn btn--text btn--sm" data-product-action="remove-task" data-group="${group.key}" data-id="${escape(task.id)}"${locked}>${t("Remove", "移除")}</button></li>`).join('')}</ul>` : `<p class="muted">${t("Move a task into this group, or remove it.", "把议题移进这个分组，或删除这个分组。")}</p>`}
        ${!group.tasks.length ? `<button type="button" class="btn btn--text btn--sm" data-product-action="remove-group" data-group="${group.key}"${locked}>${t("Remove empty group", "删除空分组")}</button>` : ''}
        <div class="dialog__row"><label class="field">${t("Target workspace", "目标工作区")}<select data-product-change="target" data-group="${group.key}"${locked}>${projects.map((project) => `<option value="${escape(project.id)}"${selected(group.target, project.id)}>${escape(projectStatus(project.id))}${project.workspaceId ? '' : t(" · no workspace", " · 没有工作区")}</option>`).join('')}</select></label><label class="field">${t("Work mode", "工作模式")}<select data-product-change="mode" data-group="${group.key}"${locked}><option value="implementation"${selected(group.mode, 'implementation')}>${t("Implementation", "实现")}</option><option value="research"${selected(group.mode, 'research')}>${t("Research only", "仅研究")}</option></select></label></div>
        <div class="dialog__row"><label class="field">${t("Recipient type", "接收方类型")}<select data-product-change="recipient-kind" data-group="${group.key}"${locked}><option value="new"${selected(group.kind, 'new')}>${t("New CLI session", "新的 CLI 会话")}</option><option value="existing"${selected(group.kind, 'existing')}>${t("Existing CLI session", "已有 CLI 会话")}</option></select></label><label class="field">${t("Recipient", "接收方")}<select data-product-change="recipient" data-group="${group.key}"${locked}><option value="">${t("Choose recipient", "选择接收方")}</option>${recipients.map((recipient) => `<option value="${escape(recipient.value)}"${selected(group.recipient, recipient.value)}${recipient.disabled ? ' disabled' : ''}>${escape(recipient.label)}</option>`).join('')}</select></label></div>
        ${(discovery?.warnings || []).map((warning) => `<p class="muted">${escape(warning)}</p>`).join('')}${isUnavailable(group.project) || isUnavailable(group.target) ? `<p class="detail__error">${t("Source or target is offline or unsupported. Sending is disabled.", "来源或目标离线或不被支持。无法发送。")}</p>` : ''}<button type="button" class="btn btn--outlined btn--sm" data-product-action="preview-group" data-group="${group.key}"${busy || !group.tasks.length || isUnavailable(group.project) || isUnavailable(group.target) ? ' disabled' : ''}>${t("Preview this group", "预览这个分组")}</button></section>`;
    }).join('');
    const renderedPreviews = previews.map((preview) => {
      const result = sent.get(preview.id);
      const blockers = preview.blockers.map((blocker) => {
        const task = preview.issues.find((issue) => issue.id === blocker.task);
        const knownDependency = task?.dependencies.some((dependency) => dependency.type === 'blocks' && dependency.id === blocker.dependency) || false;
        return `<div class="product-warning"><strong>${escape(blocker.task)} · ${escape(blocker.dependency)}</strong><p class="muted">${blocker.internal ? t("The blocker is in this group; the agent must respect Beads readiness.", "阻塞项在这个分组里，按 Beads 的就绪状态来。") : knownDependency ? t("External blocker: add it, remove this task, or choose research mode.", "外部阻塞：加进来、去掉这条，或改成研究。") : t("Inspect the live dependency graph, remove this task, or choose research mode.", "看当前依赖，去掉这条，或改成研究。")}</p>${!blocker.internal ? `${knownDependency ? `<button type="button" class="btn btn--outlined btn--sm" data-product-action="add-blocker" data-project="${escape(preview.source.id)}" data-dependent="${escape(blocker.task)}" data-id="${escape(blocker.dependency)}">${t("Add or move blocker to this group", "把阻塞项加进这个分组")}</button> ` : ''}<button type="button" class="btn btn--text btn--sm" data-product-action="remove-blocked" data-project="${escape(preview.source.id)}" data-id="${escape(blocker.task)}">${t("Remove task", "移除议题")}</button>` : ''}</div>`;
      }).join('');
      return `<section class="product-section"><h3>${t("Preview", "预览")} · ${escape(projectStatus(preview.source.id))} → ${escape(projectStatus(preview.target.id))}</h3>
        <p class="muted">${t("Mode: ", "方式：")}${escape(modeLabel(preview.group.mode))}${t(" · Actor: ", " · 操作者：")}${escape(preview.actor)}${t(" · Recipient: ", " · 接收方：")}${escape(preview.recipientState ? `${preview.recipientState.agent} / ${preview.recipientState.terminal} (${preview.recipientState.state})` : preview.group.recipient.kind === 'new' ? preview.group.recipient.agent : preview.group.recipient.terminal)}</p>
        ${blockers}
        ${preview.warnings.map((warning) => `<p class="muted">${escape(warning)}</p>`).join('')}${preview.errors.map((message) => `<p class="detail__error">${escape(message)}</p>`).join('')}
        <p class="muted">${t("Context artifact: ", "上下文文件：")}${escape(preview.contextPath || t("inline", "内联"))}${t(" · Report artifact: ", " · 报告文件：")}${escape(preview.reportPath)}</p><p class="muted">${t("Included documents: ", "包含文档：")}${preview.documents.length}${t(". Versions and document hashes are revalidated before sending.", "。发送前会重新核对版本和文档哈希。")}</p><pre class="command product-content" aria-label="${t("Complete handoff prompt", "交接全文")}">${escape(preview.prompt)}</pre>
        ${result ? `<p role="status"><strong>${t("Delivery: ", "投递：")}${escape(deliveryLabel(result.delivery))}</strong>${result.error ? ` · ${escape(result.error)}` : ''}${t(". Delivery is not task completion; check Beads and the report.", "。发出去不等于做完，看 Beads 和报告。")}</p>` : uncertain.has(preview.id) ? `<p role="status"><strong>${t("Delivery outcome unknown.", "投递结果不明。")}</strong>${t(" Check the recipient and history before preparing a new handoff. This preview will not be sent again.", " 做新交接前先看接收方和历史。这份预览不会再发。")}</p>` : `<button type="button" class="btn btn--primary" data-product-action="send" data-id="${escape(preview.id)}"${busy || preview.errors.length || isUnavailable(preview.source.id) || isUnavailable(preview.target.id) ? ' disabled' : ''}>${t("Send this handoff", "发送这份交接")}</button>`}</section>`;
    }).join('');
    return `<p class="muted">${t("Tasks stay selected across projects and filters. Each group has one source project, target workspace and recipient. Separate worktrees are recommended for parallel code changes. Sending does not claim or complete tasks.", "议题选择会跨项目和筛选保留。每个分组有一个来源项目、目标工作区和接收方。并行改代码时建议使用各自的 worktree。发送不会认领或完成议题。")}</p>${grouped || `<p class="muted">${t("Select tasks on the board first.", "先在看板上选议题。")}</p>`}<div class="detail__actions"><button type="button" class="btn btn--outlined" data-product-action="preview"${busy || !groups.some((group) => group.tasks.length) || groups.some((group) => group.tasks.length && (isUnavailable(group.project) || isUnavailable(group.target))) ? ' disabled' : ''}>${t("Preview handoffs", "预览交接")}</button><button type="button" class="btn btn--text" data-product-action="worktree">${t("Preview a worktree", "预览 worktree")}</button></div>${renderedPreviews}`;
  }

  function filtersBody(): string {
    const rows = (items: SavedFilter[], scope: 'personal' | 'project'): string => items.length ? `<ul class="product-list">${items.map((filter) => `<li><strong>${escape(filter.name)}</strong><span class="muted">${scopeLabel(scope)}</span><details class="product-filter-review"><summary>${t("Review criteria", "查看条件")}</summary><pre class="command product-content">${escape(JSON.stringify(filter.criteria, null, 2))}</pre></details><div class="detail__actions"><button type="button" class="btn btn--outlined btn--sm" data-product-action="filter-apply" data-scope="${scope}" data-id="${escape(filter.id)}">${t("Apply", "应用")}</button>${scope === 'personal' ? `<button type="button" class="btn btn--text btn--sm" data-product-action="filter-publish" data-id="${escape(filter.id)}"${isUnavailable(context.projectId()) ? ' disabled' : ''}>${t("Publish to project", "发布到项目")}</button>` : ''}<button type="button" class="btn btn--text btn--sm" data-product-action="filter-delete" data-scope="${scope}" data-id="${escape(filter.id)}"${scope === 'project' && isUnavailable(context.projectId()) ? ' disabled' : ''}>Delete</button></div></li>`).join('')}</ul>` : `<p class="muted">${t("None saved.", "尚未保存。")}</p>`;
    const projects = [...new Set([...context.projects().map((project) => project.name), ...filterProjectNames])].sort();
    const hosts = [...new Set([...context.projects().map(portableHostName).filter(Boolean), ...filterHostNames])].sort();
    return `<p class="muted">${t("Filters save dynamic criteria, not selected task IDs. Review names, queries and assignees for sensitive information before publishing, then review .beads-orca/filters.json before sharing. Publication never commits or pushes.", "筛选保存的是动态条件，不是选中的议题 ID。发布前检查名称、查询和负责人里有没有敏感信息，分享前再看 .beads-orca/filters.json。发布不会提交或推送。")}</p><label class="field">${t("Filter name", "筛选名称")}<input data-product-input="filter-name" value="${escape(filterName)}" placeholder="${t("Ready work", "就绪工作")}"></label><div class="product-section"><h3>${t("Project and host scope", "项目和主机范围")}</h3><p class="muted">${t("Match any checked project name and any checked host. Leave either list unchecked to include all. The board shows one project at a time.", "匹配任一勾选的项目名和任一勾选的主机。某一列不勾选表示不限制。看板一次只显示一个项目。")}</p><div role="group" aria-label="${t("Project names", "项目")}">${projects.map((name) => `<label class="check"><input type="checkbox" data-product-change="filter-project" data-id="${escape(name)}"${filterProjectNames.has(name) ? ' checked' : ''}><span>${escape(name)}</span></label>`).join('') || `<p class="muted">${t("No project names available.", "没有可用的项目名。")}</p>`}</div><div role="group" aria-label="${t("Host names", "主机")}">${hosts.map((name) => `<label class="check"><input type="checkbox" data-product-change="filter-host" data-id="${escape(name)}"${filterHostNames.has(name) ? ' checked' : ''}><span>${escape(name)}</span></label>`).join('') || `<p class="muted">${t("No portable host names available.", "没有可移植的主机名。")}</p>`}</div>${context.projects().some((project) => !portableHostName(project)) ? `<p class="muted">${t("Some remote hosts have no portable display name and cannot be selected by host; select their project name instead.", "有些远程主机没有可移植的显示名，不能按主机选择；请改选项目名。")}</p>` : ''}</div><button type="button" class="btn btn--outlined" data-product-action="filter-save"${busy || !filterName.trim() ? ' disabled' : ''}>${t("Save current filter", "保存当前筛选")}</button><section class="product-section"><h3>Personal</h3>${rows(filters.personal, 'personal')}</section><section class="product-section"><h3>Project</h3>${rows(filters.project, 'project')}</section>`;
  }

  function historyBody(): string {
    const entry = history.find((item) => item.id === historyId);
    const list = history.length ? `<ul class="product-list">${history.map((item) => `<li><label class="check"><input type="checkbox" data-product-change="history-select" data-id="${escape(item.id)}"${historySelection.has(item.id) ? ' checked' : ''}><span>${escape(item.id)} · ${escape(item.delivery)}${item.imported ? ' · imported, unverified' : ''} · ${escape(item.sentAt || item.preview.createdAt)}</span></label><button type="button" class="btn btn--text btn--sm" data-product-action="history-view" data-id="${escape(item.id)}">${t("View", "查看")}</button></li>`).join('')}</ul>` : `<p class="muted">${t("No personal handoff history yet.", "还没有个人交接历史。")}</p>`;
    let detail = '';
    if (entry) {
      if (entry.imported) {
        const report = entry.report;
        detail = `<section class="product-section"><h3>${t("Imported handoff ", "导入的交接 ")}${escape(entry.id)}</h3><p class="detail__error">${t("Unverified archive: delivery, receipts and reports are claims from the imported file, not proof from this Orca instance. Imported entries cannot be sent, published or used to read or remove artifacts.", "未核对的存档：投递、回执和报告都只是导入文件里的说法，不是这次 Orca 的记录。导入项不能发送、发布，也不能用来读或删产物。")}</p><p class="muted">${escape(projectName(entry.preview.source.id))} → ${escape(projectName(entry.preview.target.id))}${t(" · mode: ", " · 方式：")}${escape(modeLabel(entry.preview.group.mode))}${t(" · claimed delivery: ", " · 记录的投递：")}${escape(deliveryLabel(entry.delivery))}</p><pre class="command product-content" aria-label="${t("Imported handoff context", "导入的交接内容")}">${escape(entry.preview.prompt)}</pre><h3>${t("Imported receipt", "导入的回执")}</h3><pre class="command product-content">${escape(JSON.stringify(entry.receipt ?? null, null, 2))}</pre>${report ? `<h3>${t("Imported agent-reported results", "导入的代理报告")}</h3><p>${escape(report.summary)}</p><p class="muted">${t("Comparison base: ", "对照基线：")}${escape(report.comparisonBase || t("unknown; changes cannot be attributed automatically", "没有对照基线，改动对不上来源"))}</p><ul class="product-list">${report.tasks.map((task) => `<li><strong>${escape(task.id)} · ${escape(outcomeLabel(task.outcome))}</strong><span>${escape(task.summary)}</span><p class="muted">${t("Changes: ", "改动：")}${escape(task.changes.join(', ') || t("none reported", "没有"))}${t(" · Checks: ", " · 检查：")}${escape(task.checks.map((check) => `${check.command}: ${check.result}`).join('; ') || t("none reported", "没有"))}</p></li>`).join('')}</ul>` : '<p class="muted">No imported report.</p>'}</section>`;
      } else {
        const paths = entry.delivery === 'draft' ? [] : [entry.preview.contextPath, entry.preview.reportPath].filter((path): path is string => !!path);
        const report = entry.report;
        detail = `<section class="product-section"><h3>${t("Handoff ", "交接 ")}${escape(entry.id)}</h3><p><strong>${t("Delivery: ", "投递：")}${escape(deliveryLabel(entry.delivery))}</strong>${entry.error ? ` · ${escape(entry.error)}` : ''}</p><p class="muted">${entry.delivery === 'draft' ? t("This preview has not been sent. Delete the draft from personal history or make a new preview.", "这份预览还没发送。删掉草稿或重新预览。") : t("Delivery does not mean acceptance, Claim or completion. An unknown outcome must be checked before making a new preview.", "发出去不等于接受、认领或完成。结果不明时先核对再做新预览。")}</p><p class="muted">${escape(projectName(entry.preview.source.id))} → ${escape(projectName(entry.preview.target.id))}${t(" · mode: ", " · 方式：")}${escape(modeLabel(entry.preview.group.mode))}${t(" · actor ", " · 操作者 ")}${escape(entry.preview.actor)}</p><pre class="command product-content" aria-label="${t("Handoff context", "交接内容")}">${escape(entry.preview.prompt)}</pre><p class="muted">${t("Transport receipt: ", "传输回执：")}${escape(entry.receipt === undefined ? t("not available", "没有") : JSON.stringify(entry.receipt))}</p><div class="detail__actions"><button type="button" class="btn btn--outlined btn--sm" data-product-action="history-report"${busy || entry.delivery === 'draft' || entry.delivery === 'rejected' || isUnavailable(entry.preview.target.id) ? ' disabled' : ''}>Read structured report</button><button type="button" class="btn btn--text btn--sm" data-product-action="workspace-open"${busy || isUnavailable(entry.preview.target.id) ? ' disabled' : ''}>${t("Open", "未解决")} target workspace</button></div>
          ${report ? `<h3>${t("Agent-reported results", "代理报告")}</h3><p class="muted">${t("These claims and checks are not independently verified by the plugin. Human review decides completion.", "这些说法和检查插件没有单独核实。是否完成由人来定。")}</p><p>${escape(report.summary)}</p><p class="muted">${t("Comparison base: ", "对照基线：")}${escape(report.comparisonBase || t("unknown; changes cannot be attributed automatically", "没有对照基线，改动对不上来源"))}</p><ul class="product-list">${report.tasks.map((task) => {
            const publication = entry.publications?.find((item) => item.task === task.id);
            return `<li><label class="check"><input type="checkbox" data-product-change="publish-task" data-id="${escape(task.id)}"${publishTasks.has(task.id) ? ' checked' : ''}${publication || uncertainPublications.has(`${entry.id}\0${task.id}`) ? ' disabled' : ''}><span><strong>${escape(task.id)} · ${escape(outcomeLabel(task.outcome))}</strong> ${escape(task.summary)}</span></label><p class="muted">${t("Changes: ", "改动：")}${task.changes.length ? task.changes.map((path) => `<button type="button" class="text-link mono" data-product-action="history-open-change" data-path="${escape(path)}" aria-label="${t('Open {path} in target workspace', '在目标工作区打开 {path}', { path: escape(path) })}"${busy || isUnavailable(entry.preview.target.id) ? ' disabled' : ''}>${t('Open {path}', '打开 {path}', { path: escape(path) })}</button>`).join(', ') : t("none reported", "没有")}${t(" · Checks: ", " · 检查：")}${escape(task.checks.map((check) => `${check.command}: ${check.result}`).join('; ') || t("none reported", "没有"))}</p>${publication ? `<p class="muted">${t("Publication: ", "写入：")}${escape(outcomeLabel(publication.outcome))} · ${escape(publication.at)}${publication.error ? ` · ${escape(publication.error)}` : ''}${publication.outcome === 'unknown' ? ' · Inspect Beads before taking further action.' : ''}</p>` : uncertainPublications.has(`${entry.id}\0${task.id}`) ? '<p class="muted">Publication outcome unknown. Inspect Beads and history before taking further action.</p>' : ''}</li>`;
          }).join('')}</ul><button type="button" class="btn btn--outlined btn--sm" data-product-action="history-publish"${busy || !publishTasks.size || isUnavailable(entry.preview.source.id) ? ' disabled' : ''}>${t("Publish selected task reports to Beads", "把选中的议题报告写入 Beads")}</button>` : `<p class="muted">${t("No validated report has been read. Completion is not inferred from agent status.", "还没有读到核对过的报告。不根据代理状态推断完成。")}</p>`}
          ${paths.length ? `<h3>${t("Handoff artifacts", "交接产物")}</h3><p class="muted">${t("Artifacts may not exist yet. Removing context or report files can interrupt an executor still using them. History and worktree changes remain; stopping a session is a separate action in Orca.", "产物可能还没有。删掉上下文或报告会打断还在用它们的执行方。历史和 worktree 改动会留下；停止会话要另外在 Orca 里做。")}</p>${paths.map((path) => `<label class="check"><input type="checkbox" data-product-change="cleanup-path" data-path="${escape(path)}"${cleanupPaths.has(path) ? ' checked' : ''}${entry.artifactsRemoved?.includes(path) ? ' disabled' : ''}><span class="mono">${escape(path)}${entry.artifactsRemoved?.includes(path) ? t(" · removed", " · 已删除") : ''}</span></label>`).join('')}<button type="button" class="btn btn--text btn--sm" data-product-action="history-cleanup"${busy || !cleanupPaths.size || isUnavailable(entry.preview.target.id) ? ' disabled' : ''}>${t("Remove selected artifacts", "删除选中的产物")}</button>` : ''}</section>`;
      }
    }
    return `<p class="muted">${t("History is personal. Exports contain the exact prompt and potentially private document contents; share deliberately. Deleting history never changes Beads, stops agents, or removes artifacts.", "历史是个人的。导出包含完整提示，也可能包含私密文档。分享前自己看一眼。删除历史不会改 Beads、不会停止代理，也不会删除产物。")}</p>${list}${historyNext !== null ? `<button type="button" class="btn btn--text btn--sm" data-product-action="history-more"${busy ? ' disabled' : ''}>${t("Load more history", "加载更多历史")}</button>` : ''}<div class="detail__actions"><button type="button" class="btn btn--outlined btn--sm" data-product-action="history-export"${busy || !historySelection.size ? ' disabled' : ''}>${t("Export selected", "导出所选")}</button><button type="button" class="btn btn--text btn--sm" data-product-action="history-delete"${busy || !historySelection.size ? ' disabled' : ''}>${t("Delete selected", "删除所选")}</button></div><label class="field">${t('History export / import JSON', '历史导出 / 导入 JSON')}<textarea data-product-input="history-data" rows="5" spellcheck="false">${escape(historyData)}</textarea></label><div class="detail__actions"><button type="button" class="btn btn--outlined btn--sm" data-product-action="history-import"${busy || !historyData.trim() ? ' disabled' : ''}>${t("Import JSON", "导入 JSON")}</button>${historyData ? `<button type="button" class="btn btn--text btn--sm" data-product-action="history-download">${t("Download JSON", "下载 JSON")}</button>` : ''}</div>${detail}`;
  }

  function worktreeBody(): string {
    if (worktree && worktree.project.id !== context.projectId()) { worktree = null; worktreeResult = ''; }
    return `<p class="muted">${t("Create an isolated workspace using Orca after reviewing the host, branch and command. No Beads database is copied; worktrees are not deleted automatically.", "先核对主机、分支和命令，再用 Orca 创建隔离工作区。不会复制 Beads 数据库，也不会自动删除 worktree。")}</p><label class="field">${t("Source project", "来源项目")}<input value="${escape(projectName(context.projectId()))}" readonly></label><div class="dialog__row"><label class="field">${t("Workspace name", "工作区名称")}<input data-product-input="worktree-name" value="${escape(worktreeName)}"></label><label class="field">Branch<input data-product-input="worktree-branch" value="${escape(worktreeBranch)}"></label></div><label class="field">${t("Base branch (optional)", "基线分支（可选）")}<input data-product-input="worktree-base" value="${escape(worktreeBase)}"></label><button type="button" class="btn btn--outlined" data-product-action="worktree-preview"${busy || isUnavailable(context.projectId()) || !worktreeName.trim() || !worktreeBranch.trim() ? ' disabled' : ''}>${t("Preview worktree", "预览 worktree")}</button>${worktree ? `<section class="product-section"><h3>${t("Worktree preview", "Worktree 预览")}</h3><p>${escape(worktree.name)} · ${escape(worktree.branch)} · ${escape(worktree.host)}</p><pre class="command product-content">${escape(worktree.argv.join(' '))}</pre>${worktree.warnings.map((warning) => `<p class="muted">${escape(warning)}</p>`).join('')}<button type="button" class="btn btn--primary" data-product-action="worktree-create"${busy || isUnavailable(context.projectId()) || worktreeResult ? ' disabled' : ''}>${t("Create worktree", "创建 worktree")}</button></section>` : ''}${worktreeResult ? `<p role="status">${escape(worktreeResult)}</p>` : ''}`;
  }

  function hostsBody(): string {
    const hosts = new Map<string, Project[]>();
    for (const project of context.projects()) {
      const host = project.hostName || project.hostId || 'local';
      const entries = hosts.get(host) || []; entries.push(project); hosts.set(host, entries);
    }
    const current = context.projects().find((project) => project.current === true);
    const exampleFor = (hostId: string) => JSON.stringify({ [hostId]: { destination: 'linux-dev', configFile: '/Users/you/.ssh/config', name: t("Linux dev", "开发机") } }, null, 2);
    return `<p class="muted">${t("Projects are read on their own host. Offline snapshots are read-only; unsupported hosts remain visible. Remote Beads uses a separate system SSH connection from this Mac, not Orca's session.", "项目在各自的主机上读取。离线快照只读；不支持的主机会仍然显示。远程 Beads 使用这台 Mac 上单独的系统 SSH，不用 Orca 的会话。")}</p>${current ? `<button type="button" class="btn btn--outlined btn--sm" data-product-action="host-project" data-id="${escape(current.id)}">View current ${t("workspace ", "工作区 ")}· ${escape(current.name)}</button>` : `<p class="muted">${t("Current workspace could not be identified unambiguously.", "无法唯一确定当前工作区。")}</p>`}${[...hosts].map(([host, projects]) => `<section class="product-section"><h3>${escape(host)}</h3><ul class="product-list">${projects.map((project) => {
      const remote = project.hostId && project.hostId !== 'local';
      const unmapped = project.availability === 'unsupported' && project.hostId;
      const example = unmapped ? exampleFor(project.hostId!) : '';
      return `<li><div><strong>${escape(project.name)}</strong> ${project.current ? `<span class="muted">${t("Current workspace", "当前工作区")}</span>` : ''}<p class="muted">${escape(project.path)} · ${escape(context.projectAvailability(project))}${project.hostId ? ` · host ${escape(project.hostId)}` : ''}${project.lastFetchedAt ? ` · last fetched ${escape(project.lastFetchedAt)}` : ''}${project.availabilityReason ? ` · ${escape(project.availabilityReason)}` : ''}${project.cacheError ? ` · ${t("Offline cache unavailable", "没有离线缓存")}: ${escape(project.cacheError)}` : ''}</p>${unmapped ? `<label class="field">${t("remoteHosts entry", "remoteHosts 条目")}<textarea readonly rows="6">${escape(example)}</textarea></label><button type="button" class="btn btn--outlined btn--sm" data-product-action="copy-remote-hosts">${t("Copy remoteHosts JSON", "复制 remoteHosts JSON")}</button>` : ''}${remote && !unmapped ? `<button type="button" class="btn btn--outlined btn--sm" data-product-action="ssh-test" data-id="${escape(project.id)}"${busy ? ' disabled' : ''}>${t("Test SSH connection", "测试 SSH 连接")}</button>` : ''}</div><button type="button" class="btn btn--text btn--sm" data-product-action="host-project" data-id="${escape(project.id)}">${t("View project", "查看项目")}</button></li>`;
    }).join('')}</ul></section>`).join('') || `<p class="muted">${t("No projects available.", "没有可用项目。")}</p>`}${sshReport ? `<pre class="command product-content" aria-label="${t("SSH connection test", "SSH 检查")}">${escape(sshReport)}</pre>` : ''}`;
  }

  function dialog(): string {
    syncPanelLocale();
    if (!panel) return '';
    const titles = { handoff: t("Prepare handoffs", "准备交接"), history: t("Handoff history", "交接历史"), filters: t("Saved filters", "已保存的筛选"), worktree: t("Create worktree", "创建 worktree"), hosts: t("Hosts and projects", "主机和项目") };
    const body = panel === 'handoff' ? handoffBody() : panel === 'history' ? historyBody() : panel === 'filters' ? filtersBody() : panel === 'worktree' ? worktreeBody() : hostsBody();
    return `<dialog class="dialog product-dialog" data-product-dialog aria-labelledby="product-heading"><div class="product-dialog__inner"><header class="dialog__header"><h2 id="product-heading">${titles[panel]}</h2><button type="button" class="btn btn--text btn--sm" data-product-action="close"${busy ? ' disabled' : ''}>${t("Close", "关闭")}</button></header><div class="dialog__body">${error ? `<p class="detail__error" role="alert">${escape(error)}</p>` : ''}${notice ? `<p role="status">${escape(notice)}</p>` : ''}${busy ? `<p class="muted" role="status">${t("Working…", "处理中…")}</p>` : ''}${body}</div></div></dialog>`;
  }

  function close(): void {
    if (busy) return;
    panel = null; error = ''; notice = ''; context.render();
  }

  async function onClick(target: HTMLElement): Promise<boolean> {
    const action = target.dataset.productAction;
    if (!action) return false;
    const id = target.dataset.id || '';
    const group = groups.find((item) => item.key === Number(target.dataset.group));
    if (action === 'handoff' || action === 'history' || action === 'filters' || action === 'worktree' || action === 'hosts') { await open(action); return true; }
    if (action === 'close') { close(); return true; }
    if (action === 'documents-retry') { documentLinks.delete(`${context.projectId()}\0${id}`); void loadDocuments(context.projectId(), id); return true; }
    if (action === 'documents-expand') {
      const key = `${context.projectId()}\0${context.issueId()}`;
      if (expandedDocuments.has(key)) expandedDocuments.delete(key);
      else expandedDocuments.add(key);
      context.render(); return true;
    }
    if (action === 'document-read' || action === 'document-open' || action === 'document-add' || action === 'document-open-manual') {
      const project = context.projectId();
      const manual = action === 'document-add' || action === 'document-open-manual';
      const opening = action === 'document-open' || action === 'document-open-manual';
      const path = manual ? manualPath.trim() : target.dataset.path || '';
      if (!path || isUnavailable(project) || busy) return true;
      const issueKey = `${project}\0${context.issueId()}`;
      busy = true; documentErrors.delete(issueKey); documentStatus.delete(issueKey); context.render();
      try {
        if (opening) {
          const result = await context.transport.request<DocumentOpenResult>({ method: 'documents.open', project, input: { path } });
          documentStatus.set(issueKey, t('Opened {path} in the workspace editor.', '已在编辑器打开 {path}。', { path: result.path }));
          if (manual) {
            if (!manualDocuments.has(project)) manualDocuments.set(project, new Set());
            manualDocuments.get(project)!.add(result.path); manualPath = '';
          }
        } else {
          const result = await context.transport.request<DocumentResult>({ method: 'documents.read', project, input: { path } });
          documentResults.set(`${project}\0${result.path}`, result);
          if (manual) {
            if (!manualDocuments.has(project)) manualDocuments.set(project, new Set());
            manualDocuments.get(project)!.add(result.path); manualPath = '';
          }
        }
      } catch (reason) { documentErrors.set(issueKey, reason instanceof Error ? reason.message : String(reason)); }
      finally { busy = false; context.render(); }
      return true;
    }
    if (action === 'add-group' && group) { groups.push({ ...group, key: nextGroup++, tasks: [] }); previews = []; context.render(); return true; }
    if (action === 'remove-group' && group && !group.tasks.length) { groups = groups.filter((item) => item !== group); previews = []; context.render(); return true; }
    if (action === 'remove-task' && group) { group.tasks = group.tasks.filter((item) => item.id !== id); context.removeTask(group.project, id); previews = []; context.render(); return true; }
    if (action === 'add-blocker' || action === 'remove-blocked') {
      const project = target.dataset.project || '';
      if (action === 'add-blocker') {
        const destination = groups.find((candidate) => candidate.project === project && candidate.tasks.some((task) => task.id === target.dataset.dependent));
        if (!destination) return true;
        const previous = groups.find((candidate) => candidate.project === project && candidate.tasks.some((task) => task.id === id));
        const item = previous?.tasks.find((task) => task.id === id) || { project, id, title: id };
        if (previous && previous !== destination) previous.tasks = previous.tasks.filter((task) => task.id !== id);
        if (previous !== destination) destination.tasks.push(item);
        context.addTask(item);
      } else { context.removeTask(project, id); for (const candidate of groups.filter((item) => item.project === project)) candidate.tasks = candidate.tasks.filter((item) => item.id !== id); }
      previews = []; context.render(); return true;
    }
    if (action === 'preview' || action === 'preview-group') {
      if (action === 'preview-group' && (!group || !group.tasks.length)) return true;
      await run(async () => {
        const selectedGroups = action === 'preview-group' && group ? [group] : groups.filter((item) => item.tasks.length);
        const handoffs: HandoffGroup[] = selectedGroups.map((item) => ({ tasks: item.tasks.map((task) => ({ project: task.project, id: task.id })), target: item.target, recipient: item.kind === 'new' ? { kind: 'new', agent: item.recipient } : { kind: 'existing', terminal: item.recipient }, mode: item.mode, documents: [...included].filter((key) => key.startsWith(`${item.project}\0`)).map((key) => ({ project: item.project, path: key.slice(item.project.length + 1), ...selectedDocumentRange(key) })) }));
        if (handoffs.some((item) => isUnavailable(item.tasks[0].project) || isUnavailable(item.target))) throw new Error(t("Reconnect the source and target before previewing a handoff.", "预览前先重新连接来源和目标。"));
        previews = await workflow('handoff.preview', { groups: handoffs }); sent.clear(); uncertain.clear();
      }); return true;
    }
    if (action === 'send') {
      const preview = previews.find((item) => item.id === id);
      if (!preview || preview.errors.length || sent.has(id) || uncertain.has(id) || isUnavailable(preview.source.id) || isUnavailable(preview.target.id)) return true;
      await run(async () => {
        uncertain.add(id);
        try { sent.set(id, await workflow('handoff.send', { id })); uncertain.delete(id); }
        catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          if (message.startsWith('Handoff not sent:') || message.startsWith('没发出去：')) {
            uncertain.delete(id);
            sent.set(id, { id, preview, delivery: 'rejected', error: message });
            return;
          }
          throw new Error(t('Delivery outcome unknown: {message}. Check the recipient and history before making a new preview.', '投递结果不明：{message}。做新预览前先看接收方和历史。', { message }));
        }
      }); return true;
    }
    if (action === 'filter-save') {
      if (!filterName.trim()) return true;
      await run(async () => {
        const criteria = context.criteria();
        criteria.projectNames = [...filterProjectNames]; criteria.hostNames = [...filterHostNames];
        const filter: SavedFilter = { id: crypto.randomUUID(), name: filterName.trim(), criteria };
        await context.transport.request({ method: 'filters.save', input: { scope: 'personal', filter } });
        await loadFilters(); filterName = ''; if (!notice) notice = t("Personal filter saved.", "个人筛选已保存。");
      }); return true;
    }
    if (action === 'filter-apply' || action === 'filter-publish' || action === 'filter-delete') {
      const scope = target.dataset.scope === 'project' ? 'project' : 'personal';
      const filter = filters[scope].find((item) => item.id === id);
      if (!filter) return true;
      if (action === 'filter-apply') { context.applyCriteria(filter.criteria); close(); return true; }
      const project = context.projectId();
      if ((action === 'filter-publish' || scope === 'project') && isUnavailable(project)) return true;
      const message = action === 'filter-publish' ? t('Publish “{name}” to the project file?\n\nReview for sensitive data:\n{json}\n\nReview .beads-orca/filters.json before sharing. This does not commit or push.', '把「{name}」写到项目文件？\n\n检查有没有敏感信息：\n{json}\n\n分享前看一下 .beads-orca/filters.json。这一步不会提交或推送。', { name: filter.name, json: JSON.stringify(filter.criteria, null, 2) }) : t('Delete the {scope} filter “{name}”?', '删除{scope}筛选「{name}」？', { scope: scopeLabel(scope), name: filter.name });
      if (!await confirmProductAction(message)) return true;
      await run(async () => {
        if (action === 'filter-publish') await context.transport.request({ method: 'filters.publish', project, input: { filter } });
        else await context.transport.request({ method: 'filters.delete', ...(scope === 'project' ? { project } : {}), input: { scope, id } });
        await loadFilters();
        notice = action === 'filter-publish' ? t("Filter published to the project file. Review the change in Git.", "筛选已写到项目文件。到 Git 里看一下改动。") : t("Filter deleted.", "筛选已删除。");
      }); return true;
    }
    if (action === 'history-more') { if (historyNext !== null) await run(() => loadHistory(historyNext!)); return true; }
    if (action === 'history-view') { historyId = id; cleanupPaths.clear(); publishTasks.clear(); await run(async () => { const entry = await workflow('history.get', { id }); history = history.map((item) => item.id === id ? entry : item); }); return true; }
    if (action === 'history-export') {
      await run(async () => {
        const ids = [...historySelection], exports: HistoryExport[] = [], serialized: string[] = [];
        for (let start = 0; start < ids.length; start += 300) {
          const batch = ids.slice(start, start + 300), chunks: string[] = [];
          let offset: number | null = 0;
          let hash = '';
          while (offset !== null) {
            const page: WorkflowResults['history.export'] = await workflow('history.export', { ids: batch, offset, ...(hash ? { hash } : {}) });
            if (hash && page.hash !== hash) throw new Error(t("The history changed during export. Select entries and export again.", "导出时历史变了。重新选择再导出。"));
            hash = page.hash; chunks.push(page.text); offset = page.nextOffset;
          }
          const text = chunks.join(''); serialized.push(text); exports.push(JSON.parse(text) as HistoryExport);
        }
        historyData = serialized.length === 1 ? serialized[0] : JSON.stringify({ version: 1, warning: exports[0].warning, entries: exports.flatMap((part) => part.entries) }, null, 2);
        notice = exports[0].warning;
      }); return true;
    }
    if (action === 'history-download') {
      const url = URL.createObjectURL(new Blob([historyData], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'beads-handoff-history.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
    }
    if (action === 'history-import') {
      await run(async () => {
        JSON.parse(historyData);
        const upload = await workflow('history.import.begin', {});
        for (let offset = 0; offset < historyData.length;) {
          let end = Math.min(offset + 8192, historyData.length);
          if (end < historyData.length && /[\uD800-\uDBFF]/.test(historyData[end - 1]) && /[\uDC00-\uDFFF]/.test(historyData[end])) end--;
          await workflow('history.import.chunk', { id: upload.id, text: historyData.slice(offset, end) });
          offset = end;
        }
        const result = await workflow('history.import.finish', { id: upload.id });
        await loadHistory(); notice = t('Imported {imported}; skipped {skipped}.', '导入 {imported}；跳过 {skipped}。', { imported: result.imported.length, skipped: result.skipped.length });
      }); return true;
    }
    if (action === 'history-delete') {
      if (!historySelection.size || !await confirmProductAction(t('Delete the selected personal history? Beads tasks and agent work are not changed.', '删除选中的个人历史？Beads 议题和代理的工作不会改变。'))) return true;
      await run(async () => {
        const ids = [...historySelection];
        for (let start = 0; start < ids.length; start += 300) {
          const result = await workflow('history.delete', { ids: ids.slice(start, start + 300) });
          const deleted = new Set(result.deleted);
          for (const id of deleted) historySelection.delete(id);
          history = history.filter((item) => !deleted.has(item.id));
        }
        historyId = ''; await loadHistory(); notice = t("Selected history deleted.", "选中的历史已删除。");
      }); return true;
    }
    const entry = history.find((item) => item.id === historyId);
    if (action === 'history-open-change') {
      const path = target.dataset.path || '';
      if (!entry || entry.imported || !entry.report?.tasks.some((task) => task.changes.includes(path)) || isUnavailable(entry.preview.target.id)) return true;
      await run(async () => {
        const opened = await workflow('handoff.openChange', { id: entry.id, path });
        notice = t('Opened {path} in the target workspace.', '已在目标工作区打开 {path}。', { path: opened.path });
      }); return true;
    }
    if (entry && (action === 'history-report' || action === 'history-publish' || action === 'history-cleanup' || action === 'workspace-open')) {
      if (entry.imported) return true;
      if ((action === 'history-report' && (entry.delivery === 'draft' || entry.delivery === 'rejected')) || (action === 'history-publish' && isUnavailable(entry.preview.source.id)) || ((action === 'history-report' || action === 'history-cleanup' || action === 'workspace-open') && isUnavailable(entry.preview.target.id))) return true;
      if (action === 'history-publish' && (!publishTasks.size || !await confirmProductAction(t('Publish the selected concise task reports to Beads?', '把选中的简短议题报告发布到 Beads？')))) return true;
      if (action === 'history-cleanup' && (!cleanupPaths.size || !await confirmProductAction(t('Remove the selected handoff artifacts? This can interrupt an executor still using them. History and worktree changes remain; stop sessions separately in Orca.', '删除选中的交接产物？如果执行方还在用，可能会被打断。历史和 worktree 改动会留下；要停会话，去 Orca 里停。')))) return true;
      await run(async () => {
        let updated: HistoryEntry | undefined;
        if (action === 'history-report') updated = await workflow('handoff.report', { id: entry.id });
        else if (action === 'history-publish') {
          const taskIds = [...publishTasks];
          for (const task of taskIds) uncertainPublications.add(`${entry.id}\0${task}`);
          publishTasks.clear();
          try {
            updated = await workflow('history.publish', { id: entry.id, taskIds });
            for (const task of taskIds) uncertainPublications.delete(`${entry.id}\0${task}`);
          } catch (reason) {
            throw new Error(t('Publication outcome unknown: {reason}. Inspect Beads and history before taking further action.', '写入结果不明：{reason}。继续前先看 Beads 和历史。', { reason: reason instanceof Error ? reason.message : String(reason) }));
          }
        }
        else if (action === 'history-cleanup') updated = await workflow('handoff.cleanup', { id: entry.id, paths: [...cleanupPaths] });
        else await workflow('workspace.open', { target: entry.preview.target.id });
        if (updated) history = history.map((item) => item.id === entry.id ? updated as HistoryEntry : item);
        if (action === 'history-cleanup') cleanupPaths.clear();
        if (action === 'history-publish') publishTasks.clear();
      }); return true;
    }
    if (action === 'worktree-preview') {
      if (isUnavailable(context.projectId())) return true;
      await run(async () => { worktree = await workflow('worktree.preview', { project: context.projectId(), name: worktreeName.trim(), branch: worktreeBranch.trim(), ...(worktreeBase.trim() ? { base: worktreeBase.trim() } : {}) }); worktreeResult = ''; }); return true;
    }
    if (action === 'worktree-create') {
      if (!worktree || worktree.project.id !== context.projectId() || worktreeResult || isUnavailable(context.projectId())) return true;
      await run(async () => { worktreeResult = t("Creation outcome unknown. Check Orca before trying again.", "创建结果不明。先看 Orca 再试。"); const result = await workflow('worktree.create', { id: worktree!.id }); worktreeResult = result.outcome === 'created' ? t("Worktree created. Select it in Orca before assigning work.", "Worktree 已创建。先在 Orca 里选中再派活。") : t('Creation outcome unknown{detail} Check Orca before trying again.', '创建结果不明{detail}先看 Orca 再试。', { detail: result.error ? `：${result.error}。` : '。' }); if (result.outcome === 'created') context.reloadProjects(); }); return true;
    }
    if (action === 'host-project') { context.selectProject(id); close(); return true; }
    if (action === 'copy-remote-hosts') {
      const snippet = target.closest('li')?.querySelector('textarea')?.value || '';
      try { await navigator.clipboard.writeText(snippet); notice = t("Copied the remoteHosts entry.", "已复制 remoteHosts 条目。"); }
      catch { notice = t("Clipboard is unavailable. Select the JSON below and copy it.", "剪贴板不可用。选中下面的 JSON 再复制。"); }
      context.render(); return true;
    }
    if (action === 'ssh-test') {
      const project = id || context.projectId();
      await run(async () => {
        const result = await context.transport.request<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>({ method: 'ssh.test', project });
        sshReport = result.checks.map((check) => `${check.ok ? 'ok' : 'fail'}  ${check.name}: ${check.detail}`).join('\n');
        notice = result.ok ? t("SSH checks passed.", "SSH 检查通过。") : t("SSH checks failed. The details are below.", "SSH 检查没通过，详情在下面。");
      }); return true;
    }
    return true;
  }

  function onChange(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
    const change = target.dataset.productChange;
    if (!change) return false;
    const id = target.dataset.id || '';
    const group = groups.find((item) => item.key === Number(target.dataset.group));
    if (busy && group) { context.render(); return true; }
    if (change === 'include-document' && target instanceof HTMLInputElement) {
      const key = `${context.projectId()}\0${target.dataset.path || ''}`;
      if (target.checked) included.add(key); else included.delete(key); previews = [];
    } else if (change === 'task-group' && group) {
      const destination = groups.find((item) => item.key === Number(target.value) && item.project === group.project);
      const task = group.tasks.find((item) => item.id === id);
      if (destination && task && destination !== group) { group.tasks = group.tasks.filter((item) => item !== task); destination.tasks.push(task); }
      previews = [];
    } else if (change === 'target' && group) {
      group.target = target.value; group.recipient = ''; previews = [];
      void run(async () => { await discover(group.target); });
    } else if (change === 'mode' && group) { group.mode = target.value === 'research' ? 'research' : 'implementation'; previews = []; }
    else if (change === 'recipient-kind' && group) { group.kind = target.value === 'existing' ? 'existing' : 'new'; group.recipient = ''; previews = []; }
    else if (change === 'recipient' && group) { group.recipient = target.value; previews = []; }
    else if ((change === 'filter-project' || change === 'filter-host') && target instanceof HTMLInputElement) {
      const names = change === 'filter-project' ? filterProjectNames : filterHostNames;
      if (target.checked) names.add(id); else names.delete(id);
    }
    else if (change === 'history-select' && target instanceof HTMLInputElement) { if (target.checked) historySelection.add(id); else historySelection.delete(id); }
    else if (change === 'cleanup-path' && target instanceof HTMLInputElement) { const path = target.dataset.path || ''; if (target.checked) cleanupPaths.add(path); else cleanupPaths.delete(path); }
    else if (change === 'publish-task' && target instanceof HTMLInputElement) { if (target.checked) publishTasks.add(id); else publishTasks.delete(id); }
    context.render(); return true;
  }

  function onInput(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
    const input = target.dataset.productInput;
    if (!input) return false;
    if (input === 'manual-path') manualPath = target.value;
    else if (input === 'document-range' && (target.dataset.bound === 'startLine' || target.dataset.bound === 'endLine')) {
      const key = `${context.projectId()}\0${target.dataset.path || ''}`;
      const range = documentRanges.get(key) ?? { startLine: '', endLine: '' };
      range[target.dataset.bound] = target.value;
      documentRanges.set(key, range); previews = [];
    }
    else if (input === 'filter-name') filterName = target.value;
    else if (input === 'history-data') historyData = target.value;
    else if (input === 'worktree-name') { worktreeName = target.value; worktree = null; worktreeResult = ''; }
    else if (input === 'worktree-branch') { worktreeBranch = target.value; worktree = null; worktreeResult = ''; }
    else if (input === 'worktree-base') { worktreeBase = target.value; worktree = null; worktreeResult = ''; }
    context.render(); return true;
  }

  return { controls, documents, loadDocuments, dialog, close, onClick, onChange, onInput };
}
