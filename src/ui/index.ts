import type { Issue, Project, Snapshot, Transport } from '../shared.js';
import { relationLabel, statusLabel, syncPanelLocale, t, typeLabel } from './i18n.js';
import { preferredProjectId } from './project-selection.js';
import { icon } from './icons.js';
import { createProductUI } from './product.js';
import { createIssueModel, issueGroupOrder, portableHostName, resolveEpicProject, selectIssues, virtualRange } from './model.js';
import type { IssueGroup, IssueModel } from './model.js';
import type { FilterCriteria } from '../orca/library.js';

type Group = IssueGroup;

type Draft = { title: string; description: string; type: string; priority: string; assignee: string; labels: string };
type EditValues = { title: string; description: string; priority: string; assignee: string; notes: string; acceptance: string; design: string };
type EditDraft = { baseline: EditValues; values: EditValues };
type Comment = { author: string; text: string; created_at: string };
type SortKey = 'status' | 'id' | 'title' | 'priority' | 'relationships' | 'assignee' | 'type' | 'epic' | 'labels' | 'updated';

function groupLabel(group: Group): string {
  switch (group) {
    case 'ready': return t('Ready', '就绪');
    case 'active': return t('In progress', '进行中');
    case 'blocked': return t('Blocked', '阻塞');
    case 'closed': return t('Closed', '已关闭');
    case 'deferred': return t('Deferred', '已推迟');
    default: return t('Other', '其他');
  }
}
const groupOrder = issueGroupOrder;
const types = ['task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone'];
const typeIcons: Record<string, string> = {
  task: 'task_alt', bug: 'bug_report', feature: 'lightbulb', chore: 'handyman', epic: 'stacks',
  decision: 'gavel', spike: 'science', story: 'auto_stories', milestone: 'flag',
};
const editFields: Array<keyof EditValues> = ['title', 'description', 'priority', 'assignee', 'notes', 'acceptance', 'design'];
const cleanups = new WeakMap<HTMLElement, () => void>();
const LAST_PROJECT_KEY = 'beads-orca.lastProject';
function rememberedProject(): string {
  try { return globalThis.localStorage?.getItem(LAST_PROJECT_KEY) || ''; } catch { return ''; }
}
function rememberProject(id: string): void {
  if (!id) return;
  try { globalThis.localStorage?.setItem(LAST_PROJECT_KEY, id); } catch { /* The panel can still follow the focused workspace. */ }
}
const emptyDraft = (): Draft => ({ title: '', description: '', type: 'task', priority: '2', assignee: '', labels: '' });
const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const shell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const textError = (error: unknown): string => error instanceof Error ? error.message : String(error);
const selected = (a: string, b: string): string => a === b ? ' selected' : '';
const pressed = (yes: boolean): string => String(yes);
const bead = (group: Group): string => `<span class="bead${group === 'active' ? ' bead--active' : group === 'closed' ? ' bead--done' : ''}" aria-hidden="true"></span>`;
const priority = (issue: Issue): string => `<span class="chip chip--priority chip--p${escapeHtml(issue.priority)}">P${escapeHtml(issue.priority)}</span>`;

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return t("just now", "刚刚");
  if (minutes < 60) return t('{n} min ago', '{n} 分钟前', { n: minutes });
  if (minutes < 1440) return t('{n} h ago', '{n} 小时前', { n: Math.floor(minutes / 60) });
  return t('{n} d ago', '{n} 天前', { n: Math.floor(minutes / 1440) });
}

function createCommand(draft: Draft): string {
  const args = ['bd', '--json', '--no-color', 'create', '--repo=.', `--title=${shell(draft.title.trim())}`];
  if (draft.description.trim()) args.push(`--description=${shell(draft.description.trim())}`);
  args.push(`--type=${shell(draft.type)}`, `--priority=${shell(draft.priority)}`);
  if (draft.assignee.trim()) args.push(`--assignee=${shell(draft.assignee.trim())}`);
  const labels = draft.labels.split(',').map((label) => label.trim()).filter(Boolean);
  if (labels.length) args.push(`--labels=${shell(labels.map((label) => `"${label.replaceAll('"', '""')}"`).join(','))}`);
  return args.join(' ');
}

function editValues(issue: Issue): EditValues {
  return {
    title: issue.title, description: issue.description, priority: String(issue.priority), assignee: issue.assignee,
    notes: issue.notes ?? '', acceptance: issue.acceptance ?? '', design: issue.design ?? '',
  };
}

function changedFields(draft: EditDraft): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of editFields) {
    const value = field === 'title' ? draft.values[field].trim() : draft.values[field];
    if (value !== draft.baseline[field]) changes[field] = field === 'priority' ? Number(value) : value;
  }
  return changes;
}

function updateCommand(id: string, changes: Record<string, unknown>): string {
  const flags = editFields.filter((field) => Object.hasOwn(changes, field)).map((field) => `--${field}=${shell(String(changes[field]))}`);
  return flags.length ? ['bd', '--json', '--no-color', 'update', ...flags, '--', shell(id)].join(' ') : t("No changes to save", "没有改动");
}

function actionCommand(method: string, id: string, dependsOn = '', type = 'blocks'): string {
  const issue = shell(id);
  switch (method) {
    case 'claim': return `bd --json --no-color update --claim -- ${issue}`;
    case 'close': return `bd --json --no-color close -- ${issue}`;
    case 'reopen': return `bd --json --no-color reopen -- ${issue}`;
    case 'reclaim': return `bd --json --no-color reclaim --id=${issue}`;
    case 'link': return `bd --json --no-color dep add --type=${shell(type)} -- ${issue} ${shell(dependsOn)}`;
    case 'unlink': return `bd --json --no-color dep remove -- ${issue} ${shell(dependsOn)}`;
    default: return `bd --json --no-color --readonly show --brief-deps --id=${issue}`;
  }
}

/** Mount the live Orca Beads board into a panel-owned element. */
export function mount(root: HTMLElement, transport: Transport): void {
  cleanups.get(root)?.();
  let projects: Project[] = [];
  let projectId = '';
  let snapshot: Snapshot | null = null;
  let issueIndex = new Map<string, Issue>();
  let blockedIds = new Set<string>();
  let model: IssueModel | null = null;
  let modelSignature = '';
  let modelVersion = 0;
  let filterCacheKey = '';
  let filterCache: { counts: Record<Group | 'all', number>; visible: Issue[] } | null = null;
  let loadingProjects = true;
  let loadingSnapshot = false;
  let connectionLost = false;
  let loadError = '';
  let loadErrorSource: 'projects' | 'snapshot' = 'snapshot';
  let actionError = '';
  let pending = false;
  let disposed = false;
  let projectPickerOpen = false;
  let productReturn: 'handoff' | 'workflows' = 'workflows';
  let rendering = false;
  let refreshTask: Promise<void> | null = null;
  let detailSequence = 0;
  let detail: Issue | null = null;
  let detailLoading = false;
  let detailError = '';
  let selectedId = '';
  let view: Group | 'all' = 'all';
  let layout: 'board' | 'table' = 'board';
  let query = '';
  let typeFilter = '';
  let priorityFilter = '';
  let assigneeFilter = '';
  let showClosed = false;
  let epicFilter: FilterCriteria['epic'];
  let epicSearch = '';
  let epicStatus = '';
  let epicPriority = '';
  let epicAssignee = '';
  let epicFiltersExpanded = false;
  let filtersExpanded = false;
  let scope: { projectNames: string[]; hostNames: string[] } | null = null;
  let createOpen = false;
  let draft = emptyDraft();
  let dependencyId = '';
  let dependencyType = 'blocks';
  let dependencySearch = '';
  let sortKey: SortKey = 'status';
  let sortDirection: 'ascending' | 'descending' = 'ascending';
  let spotlightOn = true;
  let hoverId = '';
  let focusId = '';
  let drag: { id: string; project: string } | null = null;
  const taskPool = new Map<string, { project: string; id: string; title: string }>();
  const editDrafts = new Map<string, EditDraft>();
  const commentDrafts = new Map<string, string>();
  let comments: Comment[] = [];
  let commentsLoading = false;
  let commentsError = '';
  let commentsSequence = 0;
  let undoClose: { project: string; id: string; updatedAt: string; closedAt?: string } | null = null;
  let projectLoadTask: Promise<void> | null = null;
  let pathErrors: string[] = [];
  let refreshMs = 15_000;
  let snapshotGeneration = 0;
  let detailOrigin: HTMLElement | null = null;
  let projectsReloadPending = false;
  function inScope(project: Project, criteria: { projectNames: string[]; hostNames: string[] } | null): boolean {
    return !criteria || ((!criteria.projectNames.length || criteria.projectNames.includes(project.name))
      && (!criteria.hostNames.length || criteria.hostNames.includes(portableHostName(project))));
  }
  const product = createProductUI({
    root, transport,
    projects: () => projects,
    projectId: () => projectId,
    issueId: () => selectedId,
    currentUnavailable: () => offline(),
    projectAvailability,
    snapshot: () => snapshot,
    pool: () => [...taskPool.values()],
    addTask: (item) => { taskPool.set(`${item.project}\0${item.id}`, item); },
    removeTask: (project, id) => { taskPool.delete(`${project}\0${id}`); },
    criteria: () => {
      const project = projects.find((item) => item.id === projectId);
      return { query, view, layout, typeFilter, priorityFilter, assigneeFilter, showClosed, sortKey, sortDirection,
        projectNames: scope ? [...scope.projectNames] : project ? [project.name] : [],
        hostNames: scope ? [...scope.hostNames] : project && portableHostName(project) ? [portableHostName(project)] : [],
        ...(epicFilter ? { epic: { ...epicFilter } } : {}) };
    },
    applyCriteria: (criteria) => {
      const epicResolution = criteria.epic ? resolveEpicProject(projects, criteria.epic) : null;
      if (epicResolution && epicResolution.kind !== 'matched') {
        actionError = epicResolution.kind === 'ambiguous' ? t("The saved epic matches multiple registered projects. Resolve the ambiguity before applying it.", "这个需求对上了多个项目，先处理完再应用。") : t("No registered project matches the saved epic’s project and host.", "没有项目同时对上这个需求的项目和主机。");
        return;
      }
      const match = epicResolution?.kind === 'matched' ? epicResolution.project : projects.find((project) => project.id === projectId && inScope(project, criteria))
        || projects.find((project) => inScope(project, criteria));
      if (match && !inScope(match, criteria)) { actionError = t("The saved epic project is outside this filter scope.", "需求所在项目不在当前筛选里。"); return; }
      if ((criteria.projectNames.length || criteria.hostNames.length) && !match) { actionError = t("No available project matches this filter scope.", "没有项目落在这个筛选里。"); return; }
      scope = { projectNames: [...criteria.projectNames], hostNames: [...criteria.hostNames] };
      query = criteria.query; view = criteria.view; layout = criteria.layout; typeFilter = criteria.typeFilter;
      priorityFilter = criteria.priorityFilter; assigneeFilter = criteria.assigneeFilter; showClosed = criteria.showClosed;
      sortKey = criteria.sortKey; sortDirection = criteria.sortDirection;
      epicFilter = criteria.epic ? { ...criteria.epic } : undefined;
      if (match && match.id !== projectId) selectProject(match.id, false, true); else render();
    },
    selectProject: (id) => selectProject(id, false),
    reloadProjects: () => { void loadProjects(); },
    render,
  });

  const groupOf = (issue: Issue): Group => model?.groupOf(issue) ?? 'other';
  const allIssues = (): Issue[] => snapshot?.issues ?? [];
  const byId = (id: string): Issue | undefined => issueIndex.get(id);
  const relationships = (issue: Issue): string => issue.dependencies.map((dep) => `${dep.type}: ${dep.id}`).join(', ');
  const selection = () => {
    const key = JSON.stringify([modelVersion, query, typeFilter, priorityFilter, assigneeFilter, epicFilter?.id, !!epicFilter, view, showClosed]);
    if (key !== filterCacheKey || !filterCache) {
      filterCacheKey = key;
      filterCache = model ? selectIssues(model, { query, typeFilter, priorityFilter, assigneeFilter, epic: epicFilter?.id, view, showClosed })
        : { counts: { all: 0, ready: 0, active: 0, blocked: 0, closed: 0, deferred: 0, other: 0 }, visible: [] };
    }
    return filterCache;
  };
  const filtered = (): Issue[] => selection().visible;
  const count = (group: Group | 'all'): number => selection().counts[group];
  const currentIssue = (): Issue | undefined => detail?.id === selectedId ? detail : byId(selectedId);
  const disabled = (): string => pending ? ' disabled' : '';
  const offline = (): boolean => connectionLost || !snapshot || !!snapshot.offline || snapshot.project.availability === 'offline' || snapshot.project.availability === 'unsupported';

  function projectBasename(project: Project): string {
    return project.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || project.name;
  }
  function projectAvailability(project: Project): string {
    if (project.id === projectId) {
      if (loadingSnapshot || loadingProjects) return snapshot ? offline() ? t("Refreshing · stale", "刷新中 · 过期") : t("Refreshing", "刷新中") : t("Loading", "加载中");
      if (loadError || connectionLost) return snapshot ? t("Stale", "过期") : t("Unavailable", "不可用");
      if (snapshot?.offline || snapshot?.project.availability === 'offline') return t("Offline · stale", "离线 · 过期");
      if (snapshot?.project.availability === 'unsupported') return t("Unsupported", "不支持");
      if (snapshot) return t("Online", "在线");
    }
    switch (project.availability) {
      case 'online': return t("Last checked online", "上次在线");
      case 'offline': return t("Offline", "离线");
      case 'unsupported': return t("Unsupported", "不支持");
      default: return t("Not checked", "未检查");
    }
  }
  function projectSelect(): string {
    const project = projects.find((item) => item.id === projectId);
    const identities = new Map<string, number>();
    for (const item of projects) {
      const key = JSON.stringify([item.name, item.path, item.hostId || 'local']);
      identities.set(key, (identities.get(key) || 0) + 1);
    }
    const choices = projects.map((item) => {
      const key = JSON.stringify([item.name, item.path, item.hostId || 'local']);
      const identity = (identities.get(key) || 0) > 1 ? `${t(" · Workspace ID: ", " · 工作区 ID：")}${item.workspaceId || item.id}` : '';
      return `<button type="button" class="project-picker__option" data-action="choose-project" data-id="${escapeHtml(item.id)}" aria-current="${item.id === projectId ? 'true' : 'false'}"${inScope(item, scope) ? '' : ' disabled'}><span class="project-picker__option-title">${escapeHtml(projectBasename(item))}${item.current ? ` <span class="project-picker__current">${t("Current workspace", "当前工作区")}</span>` : ''}</span><span class="project-picker__meta">${escapeHtml(item.workspaceId ? t('Workspace: {name}', '工作区：{name}', { name: item.name }) : t("Additional project path", "附加路径"))} · ${escapeHtml(item.hostName || item.hostId || t("Local", "本机"))} · ${escapeHtml(projectAvailability(item))}${escapeHtml(identity)}</span><span class="project-picker__path">${escapeHtml(item.path)}</span></button>`;
    }).join('');
    return `<div class="project-picker"><button class="project-picker__trigger" type="button" data-action="toggle-project-picker" data-focus="project-picker" aria-label="${escapeHtml(project ? `${t("Choose project, selected ", "已选项目 ")}${projectBasename(project)}, ${project.workspaceId ? t('workspace {name}', '工作区 {name}', { name: project.name }) : t("additional path", "附加路径")}, ${project.hostName || project.hostId || t("Local", "本机")}, ${project.path}` : t("Choose project", "选择项目"))}"${project ? ` title="${escapeHtml(project.path)}"` : ''} aria-expanded="${pressed(projectPickerOpen)}" aria-controls="project-picker-options"${pending || !projects.length ? ' disabled' : ''}><span class="project-picker__trigger-text"><strong>${escapeHtml(project ? projectBasename(project) : loadingProjects ? t("Loading projects…", "正在加载项目…") : t("No project", "没有项目"))}</strong><span>${escapeHtml(project ? `${project.workspaceId ? t('Workspace: {name}', '工作区：{name}', { name: project.name }) : t("Additional path", "附加路径")} · ${projectAvailability(project)}` : t("Choose a workspace", "选择工作区"))}</span></span>${icon('arrow_drop_down')}</button><div id="project-picker-options" class="project-picker__panel" aria-label="${t("Available projects", "可选项目")}"${projectPickerOpen ? '' : ' hidden'}><div class="project-picker__heading">${t("Projects", "项目")} <span>${t("Workspace · host · path", "工作区 · 主机 · 路径")}</span></div>${scope ? `<p class="project-picker__scope">${t("Saved filter scope limits project choices. Clear filters to see all projects.", "已保存的筛选范围限制了可选项目。清除筛选以查看全部项目。")}</p>` : ''}<div class="project-picker__list">${choices}</div></div></div>`;
  }

  function searchField(): string {
    return `<label class="search">${icon('search')}<span class="visually-hidden">${t("Search issues", "搜索议题")}</span><input data-input="search" data-focus="search" type="search" aria-label="${t("Search issues", "搜索议题")}" placeholder="${t("Search by title, ID or label", "按标题、ID 或标签搜索")}" value="${escapeHtml(query)}" autocomplete="off"><kbd>/</kbd></label>`;
  }

  function errorBanner(): string {
    const reason = loadError || snapshot?.project.availabilityReason || '';
    const stale = snapshot && offline() ? `<div class="banner banner--state" role="status"><div><strong>${t("Showing stale, read-only data", "正在显示过期的只读数据")}</strong><p>${t("Last fetched ", "上次获取 ")}${escapeHtml(snapshot.fetchedAt)}${t(". Refresh to reconnect before changing issues or sending work.", "。改议题或派活前先刷新重连。")}</p>${reason ? `<details data-persist="load-details"><summary data-focus="load-details">${t("Technical details", "技术细节")}</summary><p>${escapeHtml(reason)}</p></details>` : ''}</div><button class="btn btn--outlined btn--sm" data-action="retry" type="button"${pending || loadingSnapshot || loadingProjects ? ' disabled' : ''}>${t("Retry loading", "重新加载")}</button></div>` : '';
    const error = actionError && !createOpen ? `<div class="banner" role="alert">${icon('error')}<div><strong>${t("Could not complete the action", "操作没有完成")}</strong><p>${escapeHtml(actionError)}</p></div><button class="btn btn--icon" data-action="dismiss-error" type="button" aria-label="${t("Dismiss error", "关闭错误")}">${icon('close')}</button></div>` : '';
    const undo = undoClose && undoClose.project === projectId ? `<div class="banner banner--undo" role="status"><div><strong>${t('Closed {id}', '已关闭 {id}', { id: escapeHtml(undoClose.id) })}</strong><p>${t("Undo reopens this issue if it has not changed.", "如果议题没有变化，撤销会重新打开它。")}</p></div><button class="btn btn--outlined btn--sm" type="button" data-action="undo-close" title="${escapeHtml(actionCommand('reopen', undoClose.id))}"${disabled()}>${t("Undo", "撤销")}</button><button class="btn btn--icon" type="button" data-action="dismiss-undo" aria-label="${t("Dismiss close message", "关闭这条关闭提示")}">${icon('close')}</button></div>` : '';
    const cacheNotice = snapshot?.project.cacheError && !offline() ? `<div class="banner" role="status"><div><strong>${t("Offline cache unavailable", "离线缓存不可用")}</strong><p>${escapeHtml(snapshot.project.cacheError)} The current snapshot is live but may not be available offline.</p></div></div>` : '';
    const paths = pathErrors.length ? `<div class="banner" role="status"><div><strong>${t("Some additional project paths were skipped", "有些附加项目路径被跳过了")}</strong><pre class="command">${escapeHtml(pathErrors.join('\n'))}</pre></div></div>` : '';
    return stale + cacheNotice + paths + error + undo;
  }

  function createButton(): string {
    return `<button type="button" class="btn btn--primary" data-action="new" aria-label="${t("New issue", "新建议题")}"${disabled()}${projectId ? '' : ' disabled'}>${icon('add')}<span>${t("New issue", "新建议题")}</span><kbd>N</kbd></button>`;
  }

  function card(issue: Issue): string {
    const group = groupOf(issue);
    const dependencyBlocked = blockedIds.has(issue.id);
    return `<article class="issue-card${selectedId === issue.id ? ' issue-card--selected' : ''}${group === 'closed' ? ' issue-card--closed' : ''}" draggable="${pressed(!pending && !offline())}" data-action="select" data-id="${escapeHtml(issue.id)}" title="${t("Drag to move, or open for keyboard-accessible actions", "拖动以移动，或打开后用键盘操作")}">
      <span class="issue-card__top"><input type="checkbox" data-change="pool" data-id="${escapeHtml(issue.id)}" aria-label="${t('Select {id} for handoff', '把 {id} 选入交接', { id: escapeHtml(issue.id) })}"${taskPool.has(`${projectId}\0${issue.id}`) ? ' checked' : ''}>${icon(typeIcons[issue.type] ?? 'task_alt')}<span class="mono">${escapeHtml(issue.id)}</span>${priority(issue)}</span>
      <span class="issue-card__relation" hidden></span>
      <button type="button" class="text-link issue-card__title" data-action="select" data-id="${escapeHtml(issue.id)}" aria-label="${t('Open {id}: {title}', '打开 {id}：{title}', { id: escapeHtml(issue.id), title: escapeHtml(issue.title) })}">${escapeHtml(issue.title)}</button>
      ${dependencyBlocked ? `<span class="issue-card__blockers">${icon('lock')}<span>${t("Blocked by dependencies", "被依赖阻塞")}</span></span>` : ''}
      ${issue.dependencies.length ? `<span class="issue-card__footer">${t("Relationships", "关系")}: ${escapeHtml(relationships(issue))}</span>` : ''}
      <span class="issue-card__footer"><span>${escapeHtml(typeLabel(issue.type))}</span>${issue.assignee ? `<span>${escapeHtml(issue.assignee)}</span>` : `<span>${t("Unassigned", "未指派")}</span>`}</span>
      ${issue.labels.length ? `<span class="issue-card__labels">${issue.labels.map((label) => `<span class="chip chip--label">${escapeHtml(label)}</span>`).join('')}</span>` : ''}
    </article>`;
  }

  type WindowState = { items: Issue[]; heights: number[]; offsets: number[]; estimate: number; table: boolean };
  const windows = new Map<string, WindowState>();
  let windowFrame = 0;
  let measureFrame = 0;
  function updateOffsets(state: WindowState): void {
    state.offsets[0] = 0;
    for (let index = 0; index < state.heights.length; index++) state.offsets[index + 1] = state.offsets[index]! + state.heights[index]!;
  }
  function registerWindow(key: string, items: Issue[], estimate: number, table: boolean): void {
    const state = { items, heights: items.map(() => estimate), offsets: [0], estimate, table };
    updateOffsets(state);
    windows.set(key, state);
  }
  function tableContent(issues: Issue[]): string {
    const headers: Array<[SortKey, string]> = [
      ['title', t("Title", "标题")], ['status', t("Status", "状态")], ['priority', t("Priority", "优先级")], ['epic', t("Epic", "需求")],
      ['assignee', t("Assignee", "负责人")], ['type', t("Type", "类型")], ['relationships', t("Relationships", "关系")], ['labels', t("Labels", "标签")], ['updated', t("Updated", "更新")],
    ];
    const value = (issue: Issue): string | number => {
      switch (sortKey) {
        case 'status': return groupOrder.indexOf(groupOf(issue));
        case 'priority': return issue.priority;
        case 'relationships': return relationships(issue);
        case 'epic': return model?.epicFor(issue)?.title || '';
        case 'labels': return issue.labels.join(', ');
        case 'updated': return Date.parse(issue.updatedAt) || 0;
        default: return issue[sortKey];
      }
    };
    const sorted = [...issues].sort((a, b) => {
      const left = value(a), right = value(b);
      const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      return (sortDirection === 'ascending' ? order : -order) || a.priority - b.priority || a.id.localeCompare(b.id);
    });
    registerWindow('table', sorted, 64, true);
    return `<div class="table-wrap" data-window-container="table" role="region" aria-label="${t("Issue table", "议题表格")}" tabindex="0"><table class="issue-table" aria-rowcount="${sorted.length + 1}"><thead><tr><th scope="col"><span class="visually-hidden">${t("Select for handoff", "选择以交接")}</span></th>${headers.map(([key, label]) => `<th scope="col" aria-sort="${key === sortKey || (key === 'title' && sortKey === 'id') ? sortDirection : 'none'}"><button class="table-sort" type="button" data-action="sort" data-value="${key}">${label}${key === sortKey ? `<span class="table-sort__arrow${sortDirection === 'ascending' ? ' table-sort__arrow--up' : ''}">${icon('arrow_drop_down')}</span>` : ''}</button>${key === 'title' ? ` <button class="table-sort table-sort--id" type="button" data-action="sort" data-value="id" aria-label="${t("Sort by issue ID", "按 ID 排序")}">ID${sortKey === 'id' ? `<span class="table-sort__arrow${sortDirection === 'ascending' ? ' table-sort__arrow--up' : ''}">${icon('arrow_drop_down')}</span>` : ''}</button>` : ''}</th>`).join('')}</tr></thead><tbody data-window-content="table"></tbody></table></div>`;
  }
  function tableRow(issue: Issue): string {
    const group = groupOf(issue);
    const epic = model?.epicFor(issue);
    return `<tr class="issue-table__row" data-id="${escapeHtml(issue.id)}" data-selected="${pressed(issue.id === selectedId)}"><td><input type="checkbox" data-change="pool" data-id="${escapeHtml(issue.id)}" aria-label="${t('Select {id} for handoff', '把 {id} 选入交接', { id: escapeHtml(issue.id) })}"${taskPool.has(`${projectId}\0${issue.id}`) ? ' checked' : ''}></td><td><button class="table-link" type="button" data-action="select" data-id="${escapeHtml(issue.id)}" aria-label="${t('Open {id}: {title}', '打开 {id}：{title}', { id: escapeHtml(issue.id), title: escapeHtml(issue.title) })}">${escapeHtml(issue.title)}</button><span class="mono issue-table__id">${escapeHtml(issue.id)}${issue.type === 'epic' ? ` · ${typeLabel('epic')}` : ''}</span><span class="issue-table__relation" hidden></span></td><td>${bead(group)} ${escapeHtml(groupLabel(group))}</td><td>${priority(issue)}</td><td>${escapeHtml(epic?.title || '—')}</td><td>${escapeHtml(issue.assignee || t("Unassigned", "未指派"))}</td><td>${escapeHtml(typeLabel(issue.type))}</td><td>${escapeHtml(relationships(issue) || '—')}</td><td>${issue.labels.map((label) => `<span class="chip chip--label">${escapeHtml(label)}</span>`).join(' ') || '—'}</td><td>${escapeHtml(relativeTime(issue.updatedAt))}</td></tr>`;
  }

  function syncWindow(key: string): void {
    const state = windows.get(key);
    const container = root.querySelector<HTMLElement>(`[data-window-container="${key}"]`);
    const content = root.querySelector<HTMLElement>(`[data-window-content="${key}"]`);
    if (!state || !container || !content) return;
    if (!state.table) content.setAttribute('role', 'list');
    const range = virtualRange(state.offsets, container.scrollTop, container.clientHeight || 600, state.table ? 6 : 3);
    const indices = new Set<number>();
    for (let index = range.start; index < range.end; index++) indices.add(index);
    const activeRow = document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>('[data-virtual-index]') : null;
    if (activeRow && content.contains(activeRow)) indices.add(Number(activeRow.dataset.virtualIndex));
    if (drag) {
      const dragged = state.items.findIndex((issue) => issue.id === drag!.id);
      if (dragged >= 0) indices.add(dragged);
    }
    const ordered = [...indices].filter((index) => index >= 0 && index < state.items.length).sort((a, b) => a - b);
    for (const spacer of content.querySelectorAll('.virtual-spacer')) spacer.remove();
    for (const row of content.querySelectorAll<HTMLElement>('[data-virtual-index]')) {
      if (!indices.has(Number(row.dataset.virtualIndex))) row.remove();
    }
    const rows = new Map(Array.from(content.querySelectorAll<HTMLElement>('[data-virtual-index]'), (row) => [Number(row.dataset.virtualIndex), row]));
    for (let position = 0; position < ordered.length; position++) {
      const index = ordered[position]!;
      if (rows.has(index)) continue;
      const issue = state.items[index]!;
      content.insertAdjacentHTML('beforeend', state.table ? tableRow(issue) : card(issue));
      const row = content.lastElementChild as HTMLElement;
      row.dataset.virtualIndex = String(index);
      if (state.table) row.setAttribute('aria-rowindex', String(index + 2));
      else {
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-posinset', String(index + 1));
        row.setAttribute('aria-setsize', String(state.items.length));
      }
      const next = ordered.slice(position + 1).map((item) => rows.get(item)).find(Boolean);
      if (next) content.insertBefore(row, next);
      rows.set(index, row);
    }
    const addSpacer = (height: number, before: HTMLElement | null) => {
      if (height <= 0) return;
      const spacer = document.createElement(state.table ? 'tr' : 'div');
      spacer.className = 'virtual-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      if (state.table) {
        const cell = document.createElement('td');
        cell.colSpan = 10; cell.style.height = `${height}px`;
        spacer.append(cell);
      } else spacer.style.height = `${height}px`;
      content.insertBefore(spacer, before);
    };
    let previous = 0;
    for (const index of ordered) {
      addSpacer(state.offsets[index]! - state.offsets[previous]!, rows.get(index)!);
      previous = index + 1;
    }
    addSpacer(state.offsets[state.items.length]! - state.offsets[previous]!, null);
    if (!measureFrame) measureFrame = requestAnimationFrame(measureWindows);
  }

  function measureWindows(): void {
    measureFrame = 0;
    let changed = false;
    for (const [key, state] of windows) {
      const container = root.querySelector<HTMLElement>(`[data-window-container="${key}"]`);
      const content = root.querySelector<HTMLElement>(`[data-window-content="${key}"]`);
      if (!container || !content) continue;
      const anchor = virtualRange(state.offsets, container.scrollTop, 0, 0).start;
      const oldAnchor = state.offsets[anchor] || 0;
      let localChange = false;
      for (const row of content.querySelectorAll<HTMLElement>('[data-virtual-index]')) {
        const index = Number(row.dataset.virtualIndex);
        const height = row.getBoundingClientRect().height + (state.table ? 0 : 8);
        if (height > 0 && Math.abs(height - state.heights[index]!) > 0.5) { state.heights[index] = height; localChange = true; }
      }
      if (!localChange) continue;
      updateOffsets(state);
      container.scrollTop += state.offsets[anchor]! - oldAnchor;
      changed = true;
    }
    if (changed) scheduleWindows();
  }

  function scheduleWindows(): void {
    if (!windowFrame) windowFrame = requestAnimationFrame(() => {
      windowFrame = 0;
      for (const key of windows.keys()) syncWindow(key);
      applySpotlight();
    });
  }

  function applySpotlight(): void {
    const id = hoverId || focusId || selectedId;
    const issue = byId(id);
    const relations = new Map<string, string>();
    let geometryChanged = false;
    if (issue && spotlightOn) {
      for (const dep of issue.dependencies) {
        relations.set(dep.id, dep.type === 'blocks' ? t('Dependency · blocks', '依赖 · 阻塞') : dep.type === 'discovered-from' ? t('Found in', '发现自') : relationLabel(dep.type));
      }
      for (const reference of model?.references.get(id) || []) {
        if (!relations.has(reference.issue.id)) relations.set(reference.issue.id, reference.type === 'blocks' ? t('Depends on this · blocks', '被这条阻塞') : relationLabel(reference.type));
      }
    }
    for (const element of root.querySelectorAll<HTMLElement>('.issue-card, .issue-table__row')) {
      const itemId = element.dataset.id || '';
      const relation = relations.get(itemId) || '';
      const chain = !!issue && relations.size > 0 && itemId !== id && !!relation;
      const dimmed = !!issue && relations.size > 0 && itemId !== id && !relation;
      element.classList.toggle('spotlight--chain', chain);
      element.classList.toggle('spotlight--dimmed', dimmed);
      const badge = element.querySelector<HTMLElement>('.issue-card__relation, .issue-table__relation');
      if (badge) {
        if (badge.hidden !== !chain || badge.textContent !== relation) geometryChanged = true;
        badge.hidden = !chain; badge.textContent = relation;
      }
    }
    if (geometryChanged && !measureFrame) measureFrame = requestAnimationFrame(measureWindows);
  }

  function boardContent(): string {
    const issues = filtered();
    if (!allIssues().length) return `<div class="empty-state"><h2>${t("No issues yet", "还没有议题")}</h2><p>${offline() ? t("This saved snapshot contains no issues.", "这份保存的快照里没有议题。") : t("Create the first issue in this project to start the board.", "在这个项目里创建第一条议题，看板就会开始。")}</p>${offline() ? '' : createButton()}</div>`;
    if (!issues.length) {
      const narrowed = !!(query.trim() || typeFilter || priorityFilter || assigneeFilter || epicFilter);
      return `<div class="empty-state empty-state--no-results" role="status"><div class="empty-state__content"><span class="empty-state__icon">${icon('search')}</span><h2>${narrowed ? t("No issues match these filters", "没有议题匹配这些筛选") : view === 'all' ? t("No open issues", "没有未关闭的议题") : t('No {group} issues', '没有{group}议题', { group: groupLabel(view) })}</h2><p>${narrowed ? t("Try a different search or reset the task filters to see more issues.", "换个搜索，或重置议题筛选。") : view === 'all' ? t("This project only has closed issues. Show all issues to include them.", "这个项目只剩下已关闭议题。显示全部议题即可看到它们。") : t("There are no issues in this view. Choose another status or return to All issues.", "这个视图里没有议题。换个状态，或回到全部议题。")}</p><div class="empty-state__actions">${narrowed ? `<button class="btn btn--primary" data-action="clear-filters" type="button">${t("Reset task filters", "重置议题筛选")}</button>` : ''}${!narrowed || view !== 'all' ? `<button class="btn ${narrowed ? 'btn--outlined' : 'btn--primary'}" data-action="show-all-issues" type="button">${t("Show all issues", "显示全部议题")}</button>` : ''}</div></div></div>`;
    }
    if (view !== 'all' || layout === 'table') return tableContent(issues);
    return `<div class="board" aria-label="${t("Issues by status", "按状态排列的议题")}">${groupOrder.filter((group) => (group !== 'other' || issues.some((issue) => groupOf(issue) === group)) && (showClosed || group !== 'closed')).map((group) => {
      const items = issues.filter((issue) => groupOf(issue) === group);
      registerWindow(group, items, 180, false);
      return `<section class="column" data-drop-group="${group}" aria-label="${escapeHtml(groupLabel(group))}"><h2 class="column__header">${bead(group)}<span>${escapeHtml(groupLabel(group))}</span><span class="column__count">${items.length}</span></h2><p class="column__drop-hint" hidden></p><div class="column__list" data-window-container="${group}" data-window-content="${group}" tabindex="0" aria-label="${escapeHtml(groupLabel(group))}${t(" issues", "议题")}">${items.length ? '' : `<p class="column__empty">${t("No issues", "没有议题")}</p>`}</div></section>`;
    }).join('')}</div>`;
  }

  function filters(hiddenSelection: number): string {
    const issueTypes = [...new Set(allIssues().map((issue) => issue.type))].sort();
    const assignees = [...new Set(allIssues().map((issue) => issue.assignee).filter(Boolean))].sort();
    const activeFilters = Number(!!typeFilter) + Number(!!priorityFilter) + Number(!!assigneeFilter) + Number(!!epicFilter)
      + Number(!!(scope?.projectNames.length || scope?.hostNames.length));
    return `<div class="filters${filtersExpanded ? ' filters--expanded' : ''}"><button type="button" class="btn btn--outlined btn--sm filters__toggle" data-action="toggle-filters" aria-expanded="${pressed(filtersExpanded)}" aria-controls="issue-filters">${t("Filters", "筛选")}${activeFilters ? ` (${activeFilters})` : ''}${icon('arrow_drop_down')}</button><div id="issue-filters" class="filter-bar${filtersExpanded ? ' filter-bar--expanded' : ''}" aria-label="${t("Filters", "筛选")}"><label><span class="visually-hidden">${t("Type", "类型")}</span><select data-change="type" data-focus="type" aria-label="${t("Filter by type", "按类型筛选")}"><option value="">${t("All types", "全部类型")}</option>${issueTypes.map((type) => `<option value="${escapeHtml(type)}"${selected(typeFilter, type)}>${escapeHtml(typeLabel(type))}</option>`).join('')}</select></label><label><span class="visually-hidden">${t("Priority", "优先级")}</span><select data-change="priority" data-focus="priority" aria-label="${t("Filter by priority", "按优先级")}"><option value="">${t("All priorities", "全部优先级")}</option>${[0, 1, 2, 3, 4].map((value) => `<option value="${value}"${selected(priorityFilter, String(value))}>P${value}</option>`).join('')}</select></label><label><span class="visually-hidden">${t("Assignee", "负责人")}</span><select data-change="assignee" data-focus="assignee" aria-label="${t("Filter by assignee", "按负责人")}"><option value="">${t("All assignees", "全部负责人")}</option>${assignees.map((assignee) => `<option value="${escapeHtml(assignee)}"${selected(assigneeFilter, assignee)}>${escapeHtml(assignee)}</option>`).join('')}</select></label>${view === 'all' ? `<label class="check"><input type="checkbox" data-change="closed"${showClosed ? ' checked' : ''}> ${t("Include closed", "含已关闭")}</label>` : view === 'closed' ? `<span class="muted">${t("Closed issues are always visible here", "这里始终显示已关闭议题")}</span>` : ''}<button class="btn btn--text btn--sm" type="button" data-action="clear-filters">${t("Clear filters", "清除筛选")}</button><span class="filter-bar__spacer"></span><span class="muted">${snapshot ? `${filtered().length}${t(" shown", " 条")}` : t('Issues not loaded', '议题还没加载')}${taskPool.size ? ` · ${taskPool.size}${t(" selected", " 已选")}${hiddenSelection ? ` · ${hiddenSelection}${t(" hidden by filters or project", " 被筛选或项目挡住")}` : ''}` : ''}</span>${taskPool.size ? `<button class="btn btn--text btn--sm" type="button" data-action="clear-pool">${t("Clear selection", "清除选择")}</button>` : ''}</div></div>`;
  }

  function resetEpicListFilters(): void {
    epicSearch = ''; epicStatus = ''; epicPriority = ''; epicAssignee = '';
  }

  function rail(): string {
    const groups: Array<Group | 'all'> = ['all', 'ready', 'active', 'blocked', 'closed', 'deferred'];
    if (view === 'other' || allIssues().some((issue) => groupOf(issue) === 'other')) groups.push('other');
    const project = projects.find((item) => item.id === projectId);
    const epicValue = epicFilter ? epicFilter.id === null ? 'none' : `id:${epicFilter.id}` : 'all';
    const epics = model?.epics || [];
    const needle = epicSearch.trim().toLocaleLowerCase();
    const matches = epics.filter((epic) => `${epic.id} ${epic.title}`.toLocaleLowerCase().includes(needle)
      && (!epicStatus || epic.status === epicStatus)
      && (!epicPriority || String(epic.priority) === epicPriority)
      && (!epicAssignee || (epicAssignee === 'unassigned' ? !epic.assignee : `name:${epic.assignee}` === epicAssignee)));
    const shown = matches.slice(0, 50);
    const selectedEpic = epicFilter?.id ? byId(epicFilter.id) : undefined;
    const selectedOutside = !!selectedEpic && !matches.includes(selectedEpic);
    const options = selectedEpic && !shown.includes(selectedEpic) ? [selectedEpic, ...shown] : shown;
    const active = Number(!!epicStatus) + Number(!!epicPriority) + Number(!!epicAssignee);
    const assignees = [...new Set(epics.map((epic) => epic.assignee).filter(Boolean))].sort();
    const knownStatuses = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
    const statuses = [...new Set([...knownStatuses, ...epics.map((epic) => epic.status)])];
    const epicOptions = `<option value="all"${selected(epicValue, 'all')}>${t("All epics", "全部需求")}</option><option value="none"${selected(epicValue, 'none')}>${t("No epic", "无需求")}</option>${options.map((epic) => `<option value="id:${escapeHtml(epic.id)}"${selected(epicValue, `id:${epic.id}`)}>${escapeHtml(epic.title)} · ${escapeHtml(epic.id)}${selectedOutside && epic === selectedEpic ? t(" (outside filters)", "（不在筛选里）") : ''}</option>`).join('')}`;
    return `<nav class="rail" aria-label="${t("Workspace", "工作区")}">
      <div class="rail__workspace"><span class="rail__glyph">${escapeHtml((project ? projectBasename(project) : 'B').slice(0, 2).toLocaleLowerCase())}</span><div>${projectSelect()}</div></div>
      <div class="rail__create">${createButton()}</div>
      <label class="rail__view"><span class="visually-hidden">${t("Issue view", "议题视图")}</span><select data-change="view" data-focus="view" aria-label="${t("Issue view", "议题视图")}">${groups.map((group) => `<option value="${group}"${selected(view, group)}>${group === 'all' ? t("All issues", "全部议题") : escapeHtml(groupLabel(group))}</option>`).join('')}</select></label>
      <h2 class="rail__heading">${t("Views", "视图")}</h2>
      ${groups.map((group) => `<button type="button" class="rail__item" data-action="view" data-value="${group}" aria-current="${pressed(view === group)}">${group === 'all' ? icon('view_kanban') : bead(group)}<span>${group === 'all' ? t("All issues", "全部议题") : escapeHtml(groupLabel(group))}</span><span class="rail__count">${snapshot ? count(group) : '—'}</span></button>`).join('')}
      <section class="rail__epics" aria-label="${t("Epics", "需求")}">
        <div class="rail__epic-heading"><h2>${t("Epics", "需求")}</h2><button class="btn btn--text btn--sm" type="button" data-action="toggle-epic-filters" data-focus="toggle-epic-filters" aria-label="${t("Filter epic list", "筛选需求列表")}${active ? `, ${active}${t(" active", " 项")}` : ''}" aria-expanded="${pressed(epicFiltersExpanded)}" aria-controls="epic-list-filters">${t("Filters", "筛选")}${active ? ` · ${active}` : ''}${icon('arrow_drop_down')}</button></div>
        <div class="rail__epic-controls">
          <label class="rail__epic-search"><span class="visually-hidden">${t("Search epics", "搜索需求")}</span><input type="search" data-input="epic-search" data-focus="epic-search" placeholder="${t("Search epics", "搜索需求")}" aria-label="${t("Search epics", "搜索需求")}" value="${escapeHtml(epicSearch)}"></label>
          <label class="rail__epic-picker"><span class="visually-hidden">${t("Epic", "需求")}</span><select data-change="epic" data-focus="epic-mobile" aria-label="${t("Epic", "需求")}">${epicOptions}</select></label>
        </div>
        <div class="epic-filters" id="epic-list-filters"${epicFiltersExpanded ? '' : ' hidden'}>
          <label>${t("Status", "状态")}<select data-change="epic-status" data-focus="epic-status" aria-label="${t("Epic status", "需求状态")}"><option value="">${t("All statuses", "全部状态")}</option>${statuses.map((status) => `<option value="${escapeHtml(status)}"${selected(epicStatus, status)}>${escapeHtml(statusLabel(status))}</option>`).join('')}</select></label>
          <label>${t("Priority", "优先级")}<select data-change="epic-priority" data-focus="epic-priority" aria-label="${t("Epic priority", "需求优先级")}"><option value="">${t("All priorities", "全部优先级")}</option>${[0, 1, 2, 3, 4].map((value) => `<option value="${value}"${selected(epicPriority, String(value))}>P${value}</option>`).join('')}</select></label>
          <label>${t("Assignee", "负责人")}<select data-change="epic-assignee" data-focus="epic-assignee" aria-label="${t("Epic assignee", "需求负责人")}"><option value="">${t("All assignees", "全部负责人")}</option><option value="unassigned"${selected(epicAssignee, 'unassigned')}>${t("Unassigned", "未指派")}</option>${assignees.map((name) => `<option value="${escapeHtml(`name:${name}`)}"${selected(epicAssignee, `name:${name}`)}>${escapeHtml(name)}</option>`).join('')}</select></label>
          <p>${t("Only filters the epic list, not its tasks.", "只筛选需求列表，不影响它下面的议题。")}</p>
        </div>
        <div class="rail__epic-meta"><span role="status">${snapshot ? t('{shown} of {total} epics', '{shown} / {total} 个需求', { shown: matches.length, total: epics.length }) : t("Epics not loaded", "需求还没加载")}</span><button class="btn btn--text btn--sm" type="button" data-action="clear-epic-filters" data-focus="clear-epic-filters" aria-label="${t("Reset epic list filters", "重置需求列表筛选")}"${active || epicSearch ? '' : ' disabled'}>${t("Reset", "重置")}</button></div>
        ${selectedOutside ? `<p class="rail__epic-notice">${t("Selected epic is outside these filters. Its tasks remain displayed.", "选中的需求不在这些筛选里。它的议题仍会显示。")}</p>` : ''}
        <div class="rail__epic-list">
          <button class="rail__item rail__item--epic" type="button" data-action="epic" data-value="all" aria-current="${pressed(epicValue === 'all')}">${icon('account_tree')}<span>${t("All epics", "全部需求")}</span></button>
          <button class="rail__item rail__item--epic" type="button" data-action="epic" data-value="none" aria-current="${pressed(epicValue === 'none')}">${icon('account_tree')}<span>${t("No epic", "无需求")}</span></button>
          ${options.map((epic) => `<button class="rail__item rail__item--epic" type="button" data-action="epic" data-value="id:${escapeHtml(epic.id)}" aria-current="${pressed(epicValue === `id:${epic.id}`)}" title="${escapeHtml(`${epic.title} · ${epic.id}`)}">${icon('account_tree')}<span>${escapeHtml(epic.title)} <small>${escapeHtml(epic.id)}${selectedOutside && epic === selectedEpic ? t(" · outside filters", " · 不在筛选里") : ''}</small></span></button>`).join('')}
        </div>
        ${matches.length > shown.length ? `<p class="muted rail__epic-empty">${matches.length - shown.length}${t(" more; refine the search or filters.", " 条未显示，缩小搜索或筛选。")}</p>` : snapshot && !shown.length ? `<p class="muted rail__epic-empty">${t("No matching epics. Change the filters or reset them.", "没有对上的需求。改筛选或重置。")}</p>` : ''}
      </section>
    </nav>`;
  }

  function detailActions(issue: Issue): string {
    const group = groupOf(issue);
    const button = (method: string, label: string, glyph: string, primary: boolean): string => `<button type="button" class="btn ${primary ? 'btn--primary' : 'btn--secondary'}" data-action="${method}" data-id="${escapeHtml(issue.id)}" title="${escapeHtml(actionCommand(method, issue.id))}"${disabled()}>${icon(glyph)}${label}</button>`;
    if (group === 'closed') return button('reopen', t("Reopen", "重新打开"), 'undo', false);
    const claim = group === 'ready' ? button('claim', t("Claim", "认领"), 'play_arrow', true) : '';
    const reclaim = issue.status === 'in_progress' && issue.heartbeatAt && Date.now() - Date.parse(issue.heartbeatAt) > 30 * 60_000 ? button('reclaim', t("Reclaim lease", "收回租约"), 'hourglass_disabled', false) : '';
    return `${claim}${reclaim}${button('close', t("Close", "关闭"), 'check', !claim && !reclaim)}`;
  }

  function draftKey(id: string): string {
    return `${projectId}\0${id}`;
  }

  function editSection(issue: Issue): string {
    const edit = editDrafts.get(draftKey(issue.id));
    if (!edit) return `<button type="button" class="btn btn--outlined" data-action="edit" data-id="${escapeHtml(issue.id)}"${pending || detailLoading || detailError ? ' disabled' : ''}>${t("Edit issue", "编辑议题")}</button>`;
    const values = edit.values;
    const changes = changedFields(edit);
    const field = (name: keyof EditValues, label: string, multiline = false): string => `<label class="field">${label}${multiline
      ? `<textarea name="${name}" data-input="edit" rows="3"${disabled()}>${escapeHtml(values[name])}</textarea>`
      : `<input name="${name}" data-input="edit" value="${escapeHtml(values[name])}"${name === 'title' ? ' required' : ''}${disabled()}>`}</label>`;
    return `<form class="edit-form" data-form="update"><h3>${t("Edit issue", "编辑议题")}</h3>${field('title', t("Title", "标题"))}${field('description', t("Description", "描述"), true)}
      <div class="dialog__row"><label class="field">${t("Priority", "优先级")}<select name="priority" data-input="edit"${disabled()}>${[0, 1, 2, 3, 4].map((value) => `<option value="${value}"${selected(values.priority, String(value))}>P${value}</option>`).join('')}</select></label>${field('assignee', t("Assignee", "负责人"))}</div>
      ${field('notes', t("Notes", "备注"), true)}${field('acceptance', t("Acceptance criteria", "验收标准"), true)}${field('design', t("Design", "设计"), true)}
      <div class="command" data-command="update">${escapeHtml(updateCommand(issue.id, changes))}</div>
      <div class="detail__actions"><button class="btn btn--primary" type="submit" data-update-submit${pending || !Object.keys(changes).length || !values.title.trim() ? ' disabled' : ''}>${t("Save changes", "保存更改")}</button><button class="btn btn--text" type="button" data-action="cancel-edit"${disabled()}>${t("Cancel", "取消")}</button></div></form>`;
  }

  function commentsSection(issue: Issue): string {
    const text = commentDrafts.get(draftKey(issue.id)) ?? '';
    const command = `bd --json --no-color comment -- ${shell(issue.id)} ${shell(text.trim())}`;
    return `<section class="detail__section"><h3>${t("Comments", "评论")}</h3>
      ${commentsLoading ? `<p class="muted" role="status">${t("Loading comments…", "正在加载评论…")}</p>` : ''}
      ${commentsError ? `<p class="detail__error" role="alert">${escapeHtml(commentsError)} <button class="btn btn--text btn--sm" type="button" data-action="retry-comments">${t("Retry", "重试")}</button></p>` : ''}
      ${comments.length ? `<ol class="comment-list">${comments.map((comment) => `<li><div class="comment-list__meta"><strong>${escapeHtml(comment.author)}</strong><span>${escapeHtml(relativeTime(comment.created_at) || comment.created_at)}</span></div><p class="detail__prose">${escapeHtml(comment.text)}</p></li>`).join('')}</ol>` : (!commentsLoading && !commentsError ? `<p class="muted">${t("No comments yet.", "还没有评论。")}</p>` : '')}
      <form class="comment-form" data-form="comment"><label class="field">${t("Add a comment", "添加评论")}<textarea name="text" data-input="comment" rows="3" required${disabled()}>${escapeHtml(text)}</textarea></label><div class="command" data-command="comment">${escapeHtml(command)}</div><button class="btn btn--outlined" type="submit" data-comment-submit${pending || !text.trim() ? ' disabled' : ''}>${t("Add comment", "添加评论")}</button></form></section>`;
  }

 
  function issueDetail(issue: Issue): string {
    const group = groupOf(issue);
    const deps = issue.dependencies;
    const dependents = [...new Map((model?.references.get(issue.id) || []).map((reference) => [reference.issue.id, reference.issue])).values()];
    const linked = new Set(deps.map((dependency) => dependency.id));
    const candidates = allIssues().filter((other) => other.id !== issue.id && !linked.has(other.id));
    if (dependencyId && !candidates.some((candidate) => candidate.id === dependencyId)) dependencyId = '';
    const needle = dependencySearch.trim().toLocaleLowerCase();
    const matching = candidates.filter((candidate) => `${candidate.id} ${candidate.title}`.toLocaleLowerCase().includes(needle));
    const choices = matching.slice(0, 40);
    const chosen = dependencyId ? byId(dependencyId) : undefined;
    if (chosen && !choices.some((candidate) => candidate.id === chosen.id)) choices.unshift(chosen);
    return `<div class="detail"><div class="detail__top">${icon(typeIcons[issue.type] ?? 'task_alt')}<span class="mono">${escapeHtml(issue.id)}</span>${priority(issue)}<span class="detail__spacer"></span><button type="button" class="btn btn--icon" data-action="close-detail" aria-label="${t("Close issue details", "关闭议题详情")}">${icon('close')}</button></div>
      <h2 class="detail__title">${escapeHtml(issue.title)}</h2><div class="detail__actions">${detailActions(issue)}</div>
      ${editSection(issue)}
      <dl class="meta-list"><dt>${t("Status", "状态")}</dt><dd>${escapeHtml(issue.status ? statusLabel(issue.status) : t("Unknown", "未知"))}</dd><dt>${t("View group", "视图分组")}</dt><dd>${bead(group)} ${escapeHtml(groupLabel(group))}${blockedIds.has(issue.id) && issue.status !== 'blocked' ? t(" · Blocked by dependencies", " · 被依赖阻塞") : ''}</dd><dt>${t("Type", "类型")}</dt><dd>${escapeHtml(typeLabel(issue.type))}</dd><dt>${t("Assignee", "负责人")}</dt><dd>${escapeHtml(issue.assignee || t("Unassigned", "未指派"))}</dd><dt>${t("Updated", "更新")}</dt><dd>${escapeHtml(relativeTime(issue.updatedAt) || t("Unknown", "未知"))}</dd>${issue.labels.length ? `<dt>${t("Labels", "标签")}</dt><dd>${issue.labels.map((label) => `<span class="chip chip--label">${escapeHtml(label)}</span>`).join(' ')}</dd>` : ''}</dl>
      ${detailLoading ? `<p class="muted" role="status">${t("Loading issue details…", "正在加载议题详情…")}</p>` : ''}${detailError ? `<p class="detail__error" role="alert">${escapeHtml(detailError)} <button class="btn btn--text btn--sm" type="button" data-action="retry-detail">${t("Retry", "重试")}</button></p>` : ''}
      ${issue.description ? `<section class="detail__section"><h3>${t("Description", "描述")}</h3><p class="detail__prose">${escapeHtml(issue.description)}</p></section>` : ''}
      ${issue.acceptance ? `<section class="detail__section"><h3>${t("Acceptance criteria", "验收标准")}</h3><p class="detail__prose">${escapeHtml(issue.acceptance)}</p></section>` : ''}
      ${issue.notes ? `<section class="detail__section"><h3>${t("Notes", "备注")}</h3><p class="detail__prose">${escapeHtml(issue.notes)}</p></section>` : ''}
      ${issue.design ? `<section class="detail__section"><h3>${t("Design", "设计")}</h3><p class="detail__prose">${escapeHtml(issue.design)}</p></section>` : ''}
      ${product.documents(issue)}
      <section class="detail__section"><h3>${t("Dependencies", "依赖")}</h3>${deps.length ? `<ul class="thread">${deps.map((dep) => `<li><span class="thread__node">${bead(byId(dep.id) ? groupOf(byId(dep.id) as Issue) : 'other')}</span><span><button type="button" class="text-link" data-action="select" data-id="${escapeHtml(dep.id)}"${byId(dep.id) ? '' : ' disabled'}>${escapeHtml(byId(dep.id)?.title || dep.id)}</button><span class="thread__meta mono">${escapeHtml(dep.id)} · ${escapeHtml(relationLabel(dep.type))}</span></span><button type="button" class="btn btn--icon" data-action="unlink" data-id="${escapeHtml(issue.id)}" data-depends="${escapeHtml(dep.id)}" aria-label="${t('Remove dependency {id}', '移除依赖 {id}', { id: escapeHtml(dep.id) })}" title="${escapeHtml(actionCommand('unlink', issue.id, dep.id))}"${disabled()}>${icon('close')}</button></li>`).join('')}</ul>` : `<p class="muted">${t("No dependencies.", "没有依赖。")}</p>`}
      ${dependents.length ? `<p class="muted">${t("Referenced by", "被引用")}</p><ul class="thread">${dependents.map((other) => `<li><span class="thread__node">${bead(groupOf(other))}</span><button type="button" class="text-link" data-action="select" data-id="${escapeHtml(other.id)}">${escapeHtml(other.title)} <span class="mono">${escapeHtml(other.id)}</span></button></li>`).join('')}</ul>` : ''}
      ${candidates.length ? `<form class="dependency-form" data-form="link"><label>${t("Search issues", "搜索议题")}<input type="search" data-input="dependency-search" data-focus="dependency-search" placeholder="${t("Title or ID", "标题或 ID")}" value="${escapeHtml(dependencySearch)}"${disabled()}></label><label>${t("Link issue", "关联议题")}<select name="dependsOn" data-input="dependency" aria-label="${t("Dependency issue", "依赖议题")}"${disabled()}><option value="">${t("Choose an issue", "选择议题")}</option>${choices.map((candidate) => `<option value="${escapeHtml(candidate.id)}"${selected(dependencyId, candidate.id)}>${escapeHtml(candidate.id)} · ${escapeHtml(candidate.title)}</option>`).join('')}</select></label>${matching.length > 40 ? `<span class="muted">${matching.length - 40}${t(" more; refine the search.", " 条未显示，缩小搜索。")}</span>` : ''}<label>${t("Relationship", "关系")}<select name="type" data-input="dependency-type" aria-label="${t("Dependency relationship", "关系")}"${disabled()}>${['blocks', 'parent-child', 'related', 'discovered-from'].map((type) => `<option value="${type}"${selected(dependencyType, type)}>${relationLabel(type)}</option>`).join('')}</select></label><button class="btn btn--outlined" type="submit" data-link-submit${pending || !dependencyId ? ' disabled' : ''}>${icon('add_link')}${t("Link", "关联")}</button><code class="command dependency-form__command" data-command="link">${escapeHtml(actionCommand('link', issue.id, dependencyId || 'ISSUE', dependencyType))}</code></form>` : ''}</section>
      ${commentsSection(issue)}
      <div class="command"><span>$ </span>${escapeHtml(actionCommand(group === 'ready' ? 'claim' : group === 'closed' ? 'reopen' : 'close', issue.id))}</div></div>`;
  }

  function createDialog(): string {
    if (!createOpen) return '';
    return `<dialog class="dialog" aria-labelledby="create-heading"><form data-form="create"><header class="dialog__header"><h2 id="create-heading">${t("New issue", "新建议题")}</h2><button type="button" class="btn btn--icon" data-action="cancel-create" aria-label="${t("Close", "关闭")}">${icon('close')}</button></header><div class="dialog__body"><label class="field">${t("Title", "标题")}<input name="title" data-input="draft" data-focus="create-title" value="${escapeHtml(draft.title)}" placeholder="${t("What needs to be done?", "要做什么？")}" required maxlength="300"${disabled()}></label><div class="dialog__row"><label class="field">${t("Type", "类型")}<select name="type" data-input="draft"${disabled()}>${types.map((type) => `<option value="${type}"${selected(draft.type, type)}>${typeLabel(type)}</option>`).join('')}</select></label><label class="field">${t("Priority", "优先级")}<select name="priority" data-input="draft"${disabled()}>${[0, 1, 2, 3, 4].map((value) => `<option value="${value}"${selected(draft.priority, String(value))}>P${value}</option>`).join('')}</select></label></div><label class="field">${t("Description", "描述")}<textarea name="description" data-input="draft" rows="4" placeholder="${t("Context, links, what done looks like", "背景、链接、怎样算做完")}"${disabled()}>${escapeHtml(draft.description)}</textarea></label><label class="field">${t("Assignee", "负责人")}<input name="assignee" data-input="draft" value="${escapeHtml(draft.assignee)}" autocomplete="off"${disabled()}></label><label class="field">${t("Labels, comma separated", "标签，用逗号分隔")}<input name="labels" data-input="draft" value="${escapeHtml(draft.labels)}" autocomplete="off"${disabled()}></label><div class="command" aria-label="${t("Equivalent command", "对应命令")}"><span>$ </span><span data-command="create">${escapeHtml(createCommand(draft))}</span></div>${actionError ? `<p class="detail__error" role="alert">${escapeHtml(actionError)}</p>` : ''}</div><footer class="dialog__actions"><button type="button" class="btn btn--text" data-action="cancel-create"${disabled()}>${t("Cancel", "取消")}</button><button type="submit" class="btn btn--primary"${disabled()}>${pending ? t("Creating…", "创建中…") : t("Create issue", "创建")}</button></footer></form></dialog>`;
  }

  function appBar(): string {
    const project = projects.find((item) => item.id === projectId);
    const sync = project ? `${projectAvailability(project)}${snapshot ? ` · ${relativeTime(snapshot.fetchedAt) || snapshot.fetchedAt}` : ''}` : t("Refresh", "刷新");
    return `<header class="app-bar"><div class="brand"><span class="brand__mark">${bead('closed')}${bead('active')}${bead('ready')}</span><span>beads</span></div><div class="app-bar__search">${searchField()}</div><div class="app-bar__actions"><button type="button" class="btn btn--text btn--sm" data-action="refresh" aria-label="${projectId ? t('Refresh issues', '刷新议题') : t('Refresh projects', '刷新项目')}" title="${escapeHtml(sync)}"${pending || loadingSnapshot || loadingProjects ? ' disabled' : ''}>${icon('sync')}<span>${escapeHtml(sync)}</span></button></div></header>`;
  }
  function mainHead(): string {
    const groups: Array<Group | 'all'> = ['all', 'ready', 'active', 'blocked'];
    if (!groups.includes(view)) groups.push(view);
    const effectiveLayout = view === 'all' ? layout : 'table';
    const epicLabel = !epicFilter ? t("All epics", "全部需求") : epicFilter.id === null ? t("No epic", "无需求") : model?.byId.get(epicFilter.id)?.title || epicFilter.id;
    const scopeParts = [epicLabel, typeFilter, priorityFilter ? `P${priorityFilter}` : '', assigneeFilter, query.trim() ? t('search: “{q}”', '搜索：“{q}”', { q: query.trim() }) : ''].filter(Boolean);
    const visibleIds = new Set(filtered().map((issue) => issue.id));
    const hiddenSelection = [...taskPool.values()].filter((item) => item.project !== projectId || !visibleIds.has(item.id)).length;
    return `<div class="main__head"><div class="main__title-row"><h1 class="visually-hidden" tabindex="-1" data-focus="board-heading">${view === 'all' ? t("All issues", "全部议题") : escapeHtml(groupLabel(view))}</h1><div class="summary" role="group" aria-label="${t("Issue views", "议题视图")}">${groups.map((group) => {
      const label = group === 'all' ? t("All issues", "全部议题") : groupLabel(group);
      return `<button type="button" class="view-button" data-action="view" data-value="${group}" data-focus="header-view-${group}" aria-pressed="${pressed(view === group)}" aria-label="${escapeHtml(label)}, ${snapshot ? t('{n} matching filters', '{n} 条符合筛选', { n: count(group) }) : t('issues not loaded', '议题还没加载')}"><span>${escapeHtml(label)}</span><span class="view-button__count" aria-hidden="true">${snapshot ? count(group) : '—'}</span></button>`;
    }).join('')}</div><div class="segmented" role="group" aria-label="${t("Issue layout", "议题布局")}"><button type="button" data-action="layout" data-value="board" aria-pressed="${pressed(effectiveLayout === 'board')}"${view !== 'all' ? ` disabled title="${t("Board is available in All issues; status views use Table", "看板只在「全部议题」里用，状态视图用表格")}"` : ` title="${t("Board layout", "看板")}"`}>${icon('view_kanban')}${t("Board", "看板")}</button><button type="button" data-action="layout" data-value="table" aria-pressed="${pressed(effectiveLayout === 'table')}" title="${t("Table layout", "表格")}">${icon('table_rows')}${t("Table", "表格")}</button></div></div><p class="scope-note"><strong>${t("Scope:", "范围：")}</strong> ${escapeHtml(scopeParts.join(' · '))}${view === 'all' ? `${t(" · closed ", " · 已关闭 ")}${showClosed ? t("included", "含") : t("hidden", "不含")}` : ''}${snapshot ? ` · ${filtered().length}${t(" shown", " 条")}` : ''}${taskPool.size ? ` · ${taskPool.size}${t(" selected", " 已选")}${hiddenSelection ? ` · ${hiddenSelection}${t(" hidden by filters or project", " 被筛选或项目挡住")}` : ''}` : ''}${offline() && snapshot ? t(" · stale", " · 过期") : ''}</p><div class="main__tools">${filters(hiddenSelection)}<div class="product-controls">${product.controls()}<button type="button" class="btn btn--icon" data-action="spotlight" aria-label="${t("Highlight dependencies", "高亮依赖")}" aria-pressed="${pressed(spotlightOn)}" title="${t("Highlight dependencies on hover or focus", "悬停或聚焦时高亮依赖")}">${icon('account_tree')}</button></div></div>${scope ? `<p class="muted">${t("Saved filter scope limits project choices. Clear filters to see all projects.", "已保存的筛选范围限制了可选项目。清除筛选以查看全部项目。")}</p>` : ''}</div>`;
  }

  function loadingState(): string {
    const label = loadingProjects ? t("Loading projects…", "正在加载项目…") : t("Loading issues…", "正在加载议题…");
    const line = '<span class="skeleton-line"></span>';
    const card = `<div class="skeleton-card"><div class="skeleton-card__meta">${line}${line}</div><span class="skeleton-line skeleton-line--title"></span><span class="skeleton-line skeleton-line--short"></span><div class="skeleton-card__meta">${line}${line}</div></div>`;
    const table = view !== 'all' || layout === 'table';
    const content = table
      ? `<div class="skeleton-table"><div class="skeleton-row skeleton-row--head">${line.repeat(5)}</div>${`<div class="skeleton-row"><span class="skeleton-line skeleton-line--title"></span>${line.repeat(4)}</div>`.repeat(7)}</div>`
      : `<div class="skeleton-board">${`<div class="skeleton-column"><div class="skeleton-column__heading">${line}</div>${card.repeat(3)}</div>`.repeat(4)}</div>`;
    return `<div class="loading-state"><span class="loading-state__label" role="status">${label}</span><div class="loading-state__preview" aria-hidden="true">${content}</div></div>`;
  }

  function bodyState(): string {
    if (!snapshot && (loadingProjects || loadingSnapshot)) return loadingState();
    if (!snapshot && loadError) return `<div class="empty-state empty-state--error" role="alert"><h2>${loadErrorSource === 'projects' ? t("Projects unavailable", "项目不可用") : t("Issues unavailable", "议题不可用")}</h2><p>${loadErrorSource === 'projects' ? t("Could not load the project list.", "无法加载项目列表。") : t("Could not load issues for this project.", "无法加载这个项目的议题。")}${t(" Try again to reconnect.", " 再试一次以重连。")}</p><details data-persist="load-details"><summary data-focus="load-details">${t("Technical details", "技术细节")}</summary><p>${escapeHtml(loadError)}</p></details><button class="btn btn--outlined" type="button" data-action="retry"${pending ? ' disabled' : ''}>${t("Retry loading", "重新加载")}</button></div>`;
    if (!projects.length) return `<div class="empty-state"><h2>${t("No projects available", "没有可用项目")}</h2><p>${t("Add a local Beads workspace in Orca or an additional project path in the plugin settings, then refresh.", "在 Orca 里添加本地 Beads 工作区，或在插件设置里添加项目路径，然后刷新。")}</p><button class="btn btn--outlined" type="button" data-action="retry">${t("Refresh", "刷新")}</button></div>`;
    if (!snapshot) return loadingState();
    return '';
  }


  const islandMarkup = new Map<string, string>();
  let contentKey = '';
  let initialized = false;
  let renderedDetailId = '';
  function patchIsland(name: string, html: string): void {
    if (islandMarkup.get(name) === html) return;
    const slot = root.querySelector<HTMLElement>(`[data-island="${name}"]`);
    if (slot) { slot.innerHTML = html; islandMarkup.set(name, html); }
  }

  function render(): void {
    if (disposed) return;
    syncPanelLocale();
    rendering = true;
    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const hadProductDialog = !!root.querySelector('[data-product-dialog]');
    const hadCreateDialog = !!root.querySelector('[data-island="create"] dialog');
    const hadDrawer = !!root.querySelector('.drawer:not([hidden])');
    const candidates = (container: HTMLElement): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('[data-focus], [data-input], [data-action], [data-change], [data-product-action], [data-product-input], [data-product-change]'));
    const matches = (element: HTMLElement): boolean => !!active && element.tagName === active.tagName
      && element.dataset.focus === active.dataset.focus && element.dataset.input === active.dataset.input
      && element.dataset.action === active.dataset.action && element.dataset.change === active.dataset.change
      && element.dataset.id === active.dataset.id && element.dataset.value === active.dataset.value
      && element.dataset.productAction === active.dataset.productAction && element.dataset.productInput === active.dataset.productInput
      && element.dataset.productChange === active.dataset.productChange && element.dataset.group === active.dataset.group
      && element.dataset.path === active.dataset.path && element.dataset.scope === active.dataset.scope
      && (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
        || element.name === (active as HTMLInputElement).name);
    const focusIndex = active ? candidates(root).filter(matches).indexOf(active) : -1;
    const start = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
    const end = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : null;
    const openDetails = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-persist][open]'), (element) => element.dataset.persist));
    const scrolls = new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-window-container]'), (element) => [element.dataset.windowContainer!, [element.scrollTop, element.scrollLeft] as const]));
    const boardLeft = root.querySelector<HTMLElement>('.board')?.scrollLeft || 0;
    const drawerTop = root.querySelector<HTMLElement>('.drawer')?.scrollTop || 0;
    const dialogTop = root.querySelector<HTMLElement>('.dialog__body')?.scrollTop || 0;
    const pickerTop = root.querySelector<HTMLElement>('.project-picker__list')?.scrollTop || 0;
    if (!initialized) {
      root.innerHTML = `<div class="app"><div class="island-contents" data-island="bar"></div><div class="island-contents" data-island="rail"></div><main class="main"><div class="island-contents" data-island="head"></div><div class="island-contents" data-island="banners"></div><div class="content-island" data-island="content"></div></main><aside class="drawer" data-island="drawer" aria-label="${t("Issue details", "议题详情")}" hidden></aside></div><div class="island-contents" data-island="create"></div><div class="island-contents" data-island="product"></div>`;
      initialized = true;
    }
    patchIsland('bar', appBar());
    patchIsland('rail', rail());
    patchIsland('head', mainHead());
    patchIsland('banners', errorBanner());
    root.querySelector<HTMLElement>('[data-island="content"]')!.setAttribute('aria-busy', String(loadingProjects || loadingSnapshot));
    const state = bodyState();
    const nextContentKey = state || JSON.stringify([projectId, filterCacheKey, layout, sortKey, sortDirection, allIssues().length ? '' : [offline(), pending]]);
    if (nextContentKey !== contentKey) {
      contentKey = nextContentKey;
      windows.clear();
      root.querySelector<HTMLElement>('[data-island="content"]')!.innerHTML = state || boardContent();
      for (const key of windows.keys()) syncWindow(key);
      for (const element of root.querySelectorAll<HTMLElement>('[data-window-container]')) {
        const position = scrolls.get(element.dataset.windowContainer || '');
        if (position) { element.scrollTop = position[0]; element.scrollLeft = position[1]; }
      }
      const board = root.querySelector<HTMLElement>('.board');
      if (board) board.scrollLeft = boardLeft;
      for (const key of windows.keys()) syncWindow(key);
    }
    const issue = currentIssue();
    patchIsland('drawer', issue ? issueDetail(issue) : '');
    const drawer = root.querySelector<HTMLElement>('.drawer')!;
    drawer.hidden = !issue;
    drawer.scrollTop = issue?.id === renderedDetailId ? drawerTop : 0;
    drawer.setAttribute('role', 'dialog');
    syncDrawerModality();
    root.querySelector('.app')?.classList.toggle('app--drawer-open', !!issue);
    patchIsland('create', createDialog());
    patchIsland('product', product.dialog());
    for (const element of root.querySelectorAll<HTMLDetailsElement>('details[data-persist]')) element.open = openDetails.has(element.dataset.persist);
    const dialogBody = root.querySelector<HTMLElement>('.dialog__body');
    if (dialogBody) dialogBody.scrollTop = dialogTop;
    const pickerList = root.querySelector<HTMLElement>('.project-picker__list');
    if (pickerList) pickerList.scrollTop = pickerTop;
    if (projectPickerOpen) setProjectPicker(true);
    const offlineSelectors = ['[data-action="new"]', '[data-action="edit"]', '[data-action="claim"]', '[data-action="reclaim"]', '[data-action="close"]', '[data-action="reopen"]', '[data-action="unlink"]', '[data-action="undo-close"]', '[data-form="create"] input', '[data-form="create"] select', '[data-form="create"] textarea', '[data-form="create"] button[type="submit"]', '[data-form="update"] input', '[data-form="update"] select', '[data-form="update"] textarea', '[data-form="update"] button[type="submit"]', '[data-form="comment"] textarea', '[data-form="comment"] button[type="submit"]', '[data-form="link"] input', '[data-form="link"] select', '[data-form="link"] button[type="submit"]', '[data-action="retry-comments"]', '[data-product-action="documents-retry"]'];
    for (const element of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(offlineSelectors.join(', '))) {
      if (offline()) { if (!element.disabled) element.dataset.offlineDisabled = 'true'; element.disabled = true; }
      else if (element.dataset.offlineDisabled) { element.disabled = false; delete element.dataset.offlineDisabled; }
    }
    for (const row of root.querySelectorAll<HTMLElement>('.issue-card, .issue-table__row')) {
      const id = row.dataset.id || '';
      row.classList.toggle('issue-card--selected', row.classList.contains('issue-card') && id === selectedId);
      if (row.classList.contains('issue-table__row')) row.dataset.selected = pressed(id === selectedId);
      if (row.classList.contains('issue-card')) row.draggable = !pending && !offline();
      const checkbox = row.querySelector<HTMLInputElement>('[data-change="pool"]');
      if (checkbox) checkbox.checked = taskPool.has(`${projectId}\0${id}`);
    }
    const dialog = root.querySelector<HTMLDialogElement>('dialog');
    if (dialog) {
      if (!dialog.dataset.cancelBound) {
        dialog.dataset.cancelBound = 'true';
        dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (dialog.hasAttribute('data-product-dialog')) product.close(); else if (!pending) { createOpen = false; render(); } });
      }
      if (!dialog.open && !document.querySelector('.product-confirm[open]')) dialog.showModal();
    }
    if (focusIndex >= 0 && active && !active.isConnected) {
      const next = candidates(root).filter(matches)[focusIndex];
      next?.focus({ preventScroll: true });
      if ((next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && start !== null && end !== null) {
        try { next.setSelectionRange(start, end); } catch { /* Selection is not supported by every input type. */ }
      }
      if ((active.dataset.action === 'retry' || active.dataset.action === 'refresh') && (!next || (next instanceof HTMLButtonElement && next.disabled))) root.querySelector<HTMLElement>('[data-focus="board-heading"]')?.focus({ preventScroll: true });
    }
    if (issue && issue.id !== renderedDetailId && !dialog) drawer.querySelector<HTMLElement>('[data-action="close-detail"]')?.focus({ preventScroll: true });
    renderedDetailId = issue?.id || '';
    if (hadProductDialog && !root.querySelector('[data-product-dialog]')) {
      const handoff = productReturn === 'handoff' ? root.querySelector<HTMLButtonElement>('[data-product-action="handoff"]:not(:disabled)') : null;
      (handoff || root.querySelector<HTMLElement>('[data-focus="workflows"]'))?.focus({ preventScroll: true });
    } else if (hadCreateDialog && !root.querySelector('dialog')) {
      (root.querySelector<HTMLButtonElement>('[data-action="new"]:not(:disabled)') || root.querySelector<HTMLElement>('[data-focus="board-heading"]'))?.focus({ preventScroll: true });
    }
    rendering = false;
    if (hadDrawer !== !!issue) scheduleWindows();
    if (hoverId || focusId || selectedId) applySpotlight();
  }

  async function loadProjects(): Promise<void> {
    if (projectLoadTask) { projectsReloadPending = true; return; }
    loadingProjects = true;
    loadError = '';
    render();
    const task = (async () => {
      try {
        const result = await transport.request<Project[]>({ method: 'projects' });
        if (disposed) return;
        projects = result;
        try {
          const diagnostics = await transport.request<{ pathErrors?: string[]; refreshMs?: number }>({ method: 'diagnostics' });
          pathErrors = Array.isArray(diagnostics.pathErrors) ? diagnostics.pathErrors : [];
          if (typeof diagnostics.refreshMs === 'number' && diagnostics.refreshMs >= 5_000 && diagnostics.refreshMs !== refreshMs) {
            refreshMs = diagnostics.refreshMs;
            armRefresh();
          }
        } catch { pathErrors = []; }
        const nextProject = preferredProjectId(projects, rememberedProject(), projectId);
        if (nextProject !== projectId) {
          projectId = nextProject;
          snapshot = null; issueIndex.clear(); blockedIds.clear();
          model = null; modelSignature = ''; modelVersion++; epicFilter = undefined; resetEpicListFilters();
          selectedId = ''; detail = null; detailSequence++; commentsSequence++;
          comments = []; commentsError = ''; undoClose = null;
        }
        if (projectId) rememberProject(projectId);
        loadingProjects = false;
        if (projectId) await refresh();
        else { snapshot = null; render(); }
      } catch (error) {
        if (disposed) return;
        loadingProjects = false;
        loadError = textError(error) || t("No technical details were provided.", "没有更多信息。"); loadErrorSource = 'projects'; connectionLost = !!snapshot;
        render();
      }
    })();
    projectLoadTask = task;
    try { await task; } finally {
      if (projectLoadTask === task) projectLoadTask = null;
      if (projectsReloadPending && !disposed && !pending) {
        projectsReloadPending = false;
        void loadProjects();
      }
    }
  }

  async function refresh(showLoading = false): Promise<void> {
    while (refreshTask) await refreshTask;
    const requestedProject = projectId;
    if (!requestedProject || disposed) return;
    const wasLoading = loadingSnapshot;
    loadingSnapshot = true;
    if (showLoading || (!snapshot && !wasLoading)) render();
    const request = (async () => {
      try {
        const result = await transport.request<Snapshot>({ method: 'snapshot', project: requestedProject });
        if (disposed || projectId !== requestedProject) return;
        if (result.project.id !== requestedProject) throw new Error(t("Beads returned data for a different project.", "Beads 返回了另一个项目的数据。"));
        const signature = JSON.stringify([result.project.id, result.issues, result.readyIds, result.blockedIds]);
        if (!model || signature !== modelSignature) {
          model = createIssueModel(result);
          modelSignature = signature;
          modelVersion++;
          issueIndex = model.byId;
          blockedIds = new Set(result.blockedIds);
        }
        snapshot = result;
        connectionLost = false;
        projects = projects.map((project) => project.id === result.project.id ? { ...project, ...result.project } : project);
        snapshotGeneration++;
        loadError = ''; loadErrorSource = 'snapshot';
        if (selectedId && !result.issues.some((issue) => issue.id === selectedId)) {
          selectedId = ''; detail = null; detailSequence++;
        } else if (selectedId && result.offline) {
          detail = result.issues.find((issue) => issue.id === selectedId) || null;
          detailSequence++; detailLoading = false; detailError = '';
          commentsSequence++; comments = []; commentsLoading = false; commentsError = t("Comments are unavailable offline.", "离线时没有评论。");
        } else if (selectedId) {
          const id = selectedId;
          void product.loadDocuments(requestedProject, id, result.issues.find((issue) => issue.id === id)?.updatedAt || '');
          const sequence = ++detailSequence;
          try {
            const latest = await transport.request<Issue>({ method: 'issue', project: requestedProject, input: { id } });
            if (!disposed && projectId === requestedProject && selectedId === id && sequence === detailSequence) {
              detail = latest; detailError = '';
            }
          } catch (error) {
            if (!disposed && projectId === requestedProject && selectedId === id && sequence === detailSequence) detailError = textError(error);
          } finally {
            if (!disposed && projectId === requestedProject && selectedId === id && sequence === detailSequence) detailLoading = false;
          }
          if (!disposed && projectId === requestedProject && selectedId === id) await loadComments(id, true);
        }
      } catch (error) {
        if (!disposed && projectId === requestedProject) { connectionLost = true; loadError = textError(error) || t("No technical details were provided.", "没有更多信息。"); loadErrorSource = 'snapshot'; }
      } finally {
        if (!disposed && projectId === requestedProject) { loadingSnapshot = false; render(); }
      }
    })();
    refreshTask = request;
    try { await request; } finally { if (refreshTask === request) refreshTask = null; }
  }

  async function loadComments(id: string, quiet = false): Promise<void> {
    const requestedProject = projectId;
    const sequence = ++commentsSequence;
    if (offline()) { comments = []; commentsLoading = false; commentsError = t("Comments are unavailable offline.", "离线时没有评论。"); render(); return; }
    if (!quiet) { commentsLoading = true; commentsError = ''; render(); }
    try {
      const rows = await transport.request<unknown>({ method: 'comments', project: requestedProject, input: { id } });
      if (!Array.isArray(rows) || rows.some((row: unknown) => {
        if (!row || typeof row !== 'object') return true;
        const item = row as Record<string, unknown>;
        return ['author', 'text', 'created_at'].some((field) => typeof item[field] !== 'string') || (item.issue_id !== undefined && item.issue_id !== id);
      })) throw new Error(t("Beads returned invalid comments for this issue.", "这条议题的评论数据无效。"));
      if (!disposed && projectId === requestedProject && selectedId === id && sequence === commentsSequence) {
        comments = rows as Comment[]; commentsError = '';
      }
    } catch (error) {
      if (!disposed && projectId === requestedProject && selectedId === id && sequence === commentsSequence) commentsError = textError(error);
    } finally {
      if (!disposed && projectId === requestedProject && selectedId === id && sequence === commentsSequence) { commentsLoading = false; render(); }
    }
  }

  async function loadDetail(id: string): Promise<void> {
    const requestedProject = projectId;
    const sequence = ++detailSequence;
    if (selectedId !== id) { comments = []; commentsError = ''; }
    selectedId = id;
    detail = null;
    detailError = '';
    detailLoading = true;
    dependencyId = '';
    dependencyType = 'blocks';
    dependencySearch = '';
    if (offline()) {
      detail = byId(id) || null; detailLoading = false; commentsSequence++;
      comments = []; commentsLoading = false; commentsError = t("Comments are unavailable offline.", "离线时没有评论。");
      render(); return;
    }
    render();
    void loadComments(id);
    void product.loadDocuments(requestedProject, id, byId(id)?.updatedAt || '');
    try {
      const result = await transport.request<Issue>({ method: 'issue', project: requestedProject, input: { id } });
      if (!disposed && projectId === requestedProject && selectedId === id && sequence === detailSequence) detail = result;
    } catch (error) {
      if (!disposed && projectId === requestedProject && selectedId === id && sequence === detailSequence) detailError = textError(error);
    } finally {
      if (!disposed && projectId === requestedProject && selectedId === id && sequence === detailSequence) { detailLoading = false; render(); }
    }
  }

  async function mutate(method: string, input: Record<string, unknown>): Promise<void> {
    if (pending || !projectId || offline()) return;
    pending = true;
    actionError = '';
    const requestedProject = projectId;
    render();
    try {
      if (refreshTask) await refreshTask;
      if (offline()) throw new Error(t("The project is offline. No change was sent.", "项目离线，没有提交修改。"));
      const before = snapshotGeneration;
      await transport.request({ method, project: requestedProject, input });
      if (disposed || projectId !== requestedProject) return;
      undoClose = null;
      if (method === 'create') { createOpen = false; draft = emptyDraft(); }
      if (method === 'update' && typeof input.id === 'string') editDrafts.delete(draftKey(input.id));
      if (method === 'comment' && typeof input.id === 'string') commentDrafts.delete(draftKey(input.id));
      await refresh();
      if (method === 'close' && typeof input.id === 'string' && snapshotGeneration > before) {
        const closed = selectedId === input.id && !detailError ? detail : null;
        if (closed?.status === 'closed') undoClose = { project: requestedProject, id: closed.id, updatedAt: closed.updatedAt, closedAt: closed.closedAt };
      }
    } catch (error) {
      if (!disposed && projectId === requestedProject) actionError = textError(error);
    } finally {
      if (!disposed) {
        pending = false;
        render();
        if (projectsReloadPending && !projectLoadTask) { projectsReloadPending = false; void loadProjects(); }
      }
    }
  }

  async function undoLastClose(): Promise<void> {
    const undo = undoClose;
    if (!undo || pending || offline() || projectId !== undo.project) return;
    pending = true;
    actionError = '';
    render();
    try {
      if (refreshTask) await refreshTask;
      if (offline()) throw new Error(t("The project is offline. The issue was not reopened.", "项目离线，没有重新打开。"));
      const latest = await transport.request<Issue>({ method: 'issue', project: undo.project, input: { id: undo.id } });
      if (disposed || projectId !== undo.project) return;
      if (latest.status !== 'closed' || latest.updatedAt !== undo.updatedAt || latest.closedAt !== undo.closedAt) {
        undoClose = null;
        throw new Error(t("The issue changed after it was closed; it was not reopened.", "关闭后又有改动，没有重新打开。"));
      }
      await transport.request({ method: 'reopen', project: undo.project, input: { id: undo.id } });
      undoClose = null;
      await refresh();
    } catch (error) {
      if (!disposed && projectId === undo.project) actionError = textError(error);
    } finally {
      if (!disposed) {
        pending = false;
        render();
        if (projectsReloadPending && !projectLoadTask) { projectsReloadPending = false; void loadProjects(); }
      }
    }
  }


  function openCreate(): void {
    if (!projectId || pending || offline()) return;
    actionError = '';
    createOpen = true;
    render();
    root.querySelector<HTMLInputElement>('[data-focus="create-title"]')?.focus();
  }

  function clearFilters(includeClosed = false): void {
    query = ''; typeFilter = ''; priorityFilter = ''; assigneeFilter = ''; epicFilter = undefined; showClosed = includeClosed; scope = null;
    render();
  }
  function setEpic(value: string): void {
    if (value === 'all') epicFilter = undefined;
    else {
      const project = projects.find((item) => item.id === projectId);
      const hostName = project ? portableHostName(project) : '';
      const id = value === 'none' ? null : value.startsWith('id:') ? value.slice(3) : '';
      if (!project || (id !== null && model?.byId.get(id)?.type !== 'epic')) {
        actionError = t("Choose an epic in the selected project.", "在当前项目里选一个需求。");
        render(); return;
      }
      epicFilter = { id, projectName: project.name, hostName };
    }
    actionError = '';
    render();
  }
  function closeDetail(): void {
    const id = selectedId;
    selectedId = ''; detail = null; detailSequence++; commentsSequence++;
    render();
    let origin = detailOrigin?.isConnected ? detailOrigin : null;
    if (!origin) {
      for (const [key, state] of windows) {
        const index = state.items.findIndex((item) => item.id === id);
        const container = root.querySelector<HTMLElement>(`[data-window-container="${key}"]`);
        if (index < 0 || !container) continue;
        container.scrollTop = state.offsets[index]!;
        syncWindow(key);
        origin = Array.from(container.querySelectorAll<HTMLElement>('[data-action="select"]')).find((item) => item.dataset.id === id && item instanceof HTMLButtonElement) || null;
        break;
      }
    }
    (origin || root.querySelector<HTMLElement>('[data-focus="search"]'))?.focus({ preventScroll: true });
    detailOrigin = null;
  }
  function selectProject(id: string, clearQuery: boolean, preserveEpic = false): void {
    const project = projects.find((item) => item.id === id);
    if (!project || id === projectId) return;
    if (!inScope(project, scope)) { actionError = t("This project is outside the saved filter scope. Clear filters to view it.", "这个项目不在已保存的筛选里。清除筛选后再看。"); render(); return; }
    projectId = id; rememberProject(id); snapshot = null; issueIndex.clear(); blockedIds.clear();
    model = null; modelSignature = ''; modelVersion++; resetEpicListFilters(); if (!preserveEpic) epicFilter = undefined;
    loadingSnapshot = true; connectionLost = false; selectedId = ''; detail = null; detailSequence++; commentsSequence++;
    comments = []; commentsError = ''; commentsLoading = false; undoClose = null;
    loadError = ''; actionError = ''; if (clearQuery && !scope) query = ''; render(); void refresh();
  }

  function setProjectPicker(open: boolean, focusChoice = false): void {
    projectPickerOpen = open;
    const trigger = root.querySelector<HTMLButtonElement>('[data-action="toggle-project-picker"]');
    const panel = root.querySelector<HTMLElement>('#project-picker-options');
    trigger?.setAttribute('aria-expanded', pressed(open));
    if (panel) panel.hidden = !open;
    if (open && trigger && panel) {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(480, window.innerWidth - 16);
      const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 120));
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      panel.style.top = `${top}px`;
      panel.style.maxHeight = `${Math.max(100, window.innerHeight - top - 8)}px`;
    }
    if (open && focusChoice) {
      const choice = panel?.querySelector<HTMLButtonElement>('[data-action="choose-project"][aria-current="true"]:not(:disabled)')
        || panel?.querySelector<HTMLButtonElement>('[data-action="choose-project"]:not(:disabled)');
      choice?.focus();
    }
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    const picker = root.querySelector('.project-picker');
    if (projectPickerOpen && event.target instanceof Node && !picker?.contains(event.target)) setProjectPicker(false);
    const menu = root.querySelector<HTMLDetailsElement>('.workflow-menu[open]');
    if (menu && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
  }

  function syncDrawerModality(): void {
    const mobileDrawer = !!currentIssue() && window.matchMedia('(max-width: 767px)').matches;
    for (const background of root.querySelectorAll<HTMLElement>('.app-bar, .rail, .main')) background.inert = mobileDrawer;
    const drawer = root.querySelector<HTMLElement>('.drawer');
    if (mobileDrawer) drawer?.setAttribute('aria-modal', 'true'); else drawer?.removeAttribute('aria-modal');
  }

  function onResize(): void {
    if (projectPickerOpen) setProjectPicker(true);
    syncDrawerModality();
    for (const state of windows.values()) {
      state.heights.fill(state.estimate);
      updateOffsets(state);
    }
    scheduleWindows();
  }


  function onClick(event: MouseEvent): void {
    const productTarget = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-product-action]') : null;
    if (productTarget && root.contains(productTarget)) {
      if (['handoff', 'filters', 'history', 'worktree', 'hosts'].includes(productTarget.dataset.productAction || '')) {
        productReturn = productTarget.dataset.productAction === 'handoff' ? 'handoff' : 'workflows';
      }
      const menu = productTarget.closest<HTMLDetailsElement>('.workflow-menu');
      if (menu) menu.open = false;
      void product.onClick(productTarget); return;
    }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
    if (event.target instanceof HTMLInputElement && event.target.dataset.change === 'pool') return;
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    const id = target.dataset.id || '';
    switch (action) {
      case 'toggle-project-picker': setProjectPicker(!projectPickerOpen, !projectPickerOpen); break;
      case 'choose-project':
        setProjectPicker(false);
        root.querySelector<HTMLButtonElement>('[data-action="toggle-project-picker"]')?.focus();
        if (id) selectProject(id, true);
        break;
      case 'new': openCreate(); break;
      case 'cancel-create': if (!pending) { createOpen = false; actionError = ''; render(); } break;
      case 'refresh': if (!pending) { if (projectId) void refresh(true); else void loadProjects(); } break;
      case 'retry': if (loadErrorSource === 'projects' || !projects.length) void loadProjects(); else void refresh(true); break;
      case 'retry-detail': if (selectedId) void loadDetail(selectedId); break;
      case 'retry-comments': if (selectedId) void loadComments(selectedId); break;
      case 'undo-close': void undoLastClose(); break;
      case 'dismiss-undo': undoClose = null; render(); break;
      case 'edit': {
        const issue = currentIssue();
        if (issue && !pending && !detailLoading && !detailError) {
          const baseline = editValues(issue);
          editDrafts.set(draftKey(issue.id), { baseline, values: { ...baseline } });
          render();
        }
        break;
      }
      case 'cancel-edit': if (!pending && selectedId) { editDrafts.delete(draftKey(selectedId)); render(); } break;
      case 'sort': {
        const key = target.dataset.value as SortKey;
        if (['status', 'id', 'title', 'priority', 'relationships', 'assignee', 'type', 'epic', 'labels', 'updated'].includes(key)) {
          sortDirection = key === sortKey && sortDirection === 'ascending' ? 'descending' : 'ascending';
          sortKey = key;
          render();
        }
        break;
      }
      case 'dismiss-error': actionError = ''; render(); break;
      case 'toggle-filters': filtersExpanded = !filtersExpanded; render(); break;
      case 'clear-filters': clearFilters(); break;
      case 'show-all-issues': view = 'all'; clearFilters(true); break;
      case 'toggle-epic-filters': epicFiltersExpanded = !epicFiltersExpanded; render(); break;
      case 'clear-epic-filters': resetEpicListFilters(); render(); break;
      case 'clear-pool': taskPool.clear(); render(); break;
      case 'layout': if (view === 'all' && (target.dataset.value === 'board' || target.dataset.value === 'table')) { layout = target.dataset.value; render(); } break;
      case 'spotlight': spotlightOn = !spotlightOn; render(); break;
      case 'view': view = (target.dataset.value || 'all') as Group | 'all'; render(); break;
      case 'epic': setEpic(target.dataset.value || 'all'); break;
      case 'select':
        if (id && byId(id)) {
          if (!selectedId) detailOrigin = target.closest<HTMLElement>('.issue-card, .issue-table__row')?.querySelector<HTMLElement>('button[data-action="select"]') || target;
          void loadDetail(id);
        }
        break;
      case 'close-detail': closeDetail(); break;
      case 'claim': case 'close': case 'reopen': case 'reclaim': if (id) void mutate(action, { id }); break;
      case 'unlink': if (id && target.dataset.depends) void mutate('unlink', { id, dependsOn: target.dataset.depends }); break;
    }
  }

  function onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    if (product.onChange(target)) return;
    const change = target.dataset.change;
    if (change === 'pool' && target instanceof HTMLInputElement) {
      const issue = byId(target.dataset.id || '');
      if (issue) {
        const key = `${projectId}\0${issue.id}`;
        if (target.checked) taskPool.set(key, { project: projectId, id: issue.id, title: issue.title });
        else taskPool.delete(key);
        render();
      }
    } else if (change === 'type') { typeFilter = target.value; render(); }
    else if (change === 'view' && ['all', ...groupOrder].includes(target.value)) { view = target.value as Group | 'all'; render(); }
    else if (change === 'epic') setEpic(target.value);
    else if (change === 'epic-status') { epicStatus = target.value; render(); }
    else if (change === 'epic-priority') { epicPriority = target.value; render(); }
    else if (change === 'epic-assignee') { epicAssignee = target.value; render(); }
    else if (change === 'priority') { priorityFilter = target.value; render(); }
    else if (change === 'assignee') { assigneeFilter = target.value; render(); }
    else if (change === 'closed' && target instanceof HTMLInputElement) { showClosed = target.checked; render(); }
    else onInput(event);
  }

  function onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    if (product.onInput(target)) return;
    if (target.dataset.input === 'search') {
      if (query === target.value) return;
      query = target.value;
      render();
    } else if (target.dataset.input === 'epic-search') {
      if (epicSearch !== target.value) { epicSearch = target.value; render(); }
    } else if (target.dataset.input === 'dependency-search') {
      if (dependencySearch !== target.value) { dependencySearch = target.value; render(); }
    } else if (target.dataset.input === 'draft' && target.name in draft) {
      draft[target.name as keyof Draft] = target.value;
      const command = root.querySelector<HTMLElement>('[data-command="create"]');
      if (command) command.textContent = createCommand(draft);
    } else if (target.dataset.input === 'edit' && selectedId) {
      const edit = editDrafts.get(draftKey(selectedId));
      if (!edit || !(target.name in edit.values)) return;
      edit.values[target.name as keyof EditValues] = target.value;
      for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-input="edit"]')) {
        if (field !== target && field.name === target.name) field.value = target.value;
      }
      const changes = changedFields(edit);
      for (const command of root.querySelectorAll<HTMLElement>('[data-command="update"]')) command.textContent = updateCommand(selectedId, changes);
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-update-submit]')) button.disabled = pending || offline() || !Object.keys(changes).length || !edit.values.title.trim();
    } else if (target.dataset.input === 'comment' && selectedId) {
      commentDrafts.set(draftKey(selectedId), target.value);
      for (const field of root.querySelectorAll<HTMLTextAreaElement>('[data-input="comment"]')) {
        if (field !== target) field.value = target.value;
      }
      const commandText = `bd --json --no-color comment -- ${shell(selectedId)} ${shell(target.value.trim())}`;
      for (const command of root.querySelectorAll<HTMLElement>('[data-command="comment"]')) command.textContent = commandText;
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-comment-submit]')) button.disabled = pending || offline() || !target.value.trim();
    } else if (target.dataset.input === 'dependency' || target.dataset.input === 'dependency-type') {
      if (target.dataset.input === 'dependency') dependencyId = target.value; else dependencyType = target.value;
      for (const select of root.querySelectorAll<HTMLSelectElement>('[data-input="dependency"], [data-input="dependency-type"]')) {
        select.value = select.dataset.input === 'dependency' ? dependencyId : dependencyType;
      }
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-link-submit]')) button.disabled = pending || offline() || !dependencyId;
      for (const command of root.querySelectorAll<HTMLElement>('[data-command="link"]')) {
        if (selectedId) command.textContent = actionCommand('link', selectedId, dependencyId || 'ISSUE', dependencyType);
      }
    }
  }

  function onSubmit(event: SubmitEvent): void {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (form.dataset.form === 'create') {
      const title = draft.title.trim();
      if (!title) { root.querySelector<HTMLInputElement>('[data-focus="create-title"]')?.focus(); return; }
      const input: Record<string, unknown> = { title, type: draft.type, priority: Number(draft.priority) };
      if (draft.description.trim()) input.description = draft.description.trim();
      if (draft.assignee.trim()) input.assignee = draft.assignee.trim();
      const labels = draft.labels.split(',').map((label) => label.trim()).filter(Boolean);
      if (labels.length) input.labels = labels;
      void mutate('create', input);
    } else if (form.dataset.form === 'update' && selectedId) {
      const edit = editDrafts.get(draftKey(selectedId));
      if (edit && edit.values.title.trim()) {
        const changes = changedFields(edit);
        if (Object.keys(changes).length) void mutate('update', { id: selectedId, ...changes });
      }
    } else if (form.dataset.form === 'comment' && selectedId) {
      const text = (commentDrafts.get(draftKey(selectedId)) ?? '').trim();
      if (text) void mutate('comment', { id: selectedId, text });
    } else if (form.dataset.form === 'link' && selectedId && dependencyId) {
      void mutate('link', { id: selectedId, dependsOn: dependencyId, type: dependencyType });
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (disposed || !root.isConnected || event.defaultPrevented || event.metaKey || event.altKey || event.ctrlKey) return;
    if (root.querySelector('[data-product-dialog]')) {
      if (event.key === 'Escape') { product.close(); event.preventDefault(); }
      return;
    }
    const target = event.target;
    if (projectPickerOpen) {
      if (event.key === 'Escape') {
        setProjectPicker(false);
        root.querySelector<HTMLButtonElement>('[data-action="toggle-project-picker"]')?.focus();
        event.preventDefault(); return;
      }
      if (target instanceof Element && target.closest('.project-picker') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const choices = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action="choose-project"]:not(:disabled)'));
        const index = choices.indexOf(target as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : event.key === 'ArrowDown' ? Math.min(index + 1, choices.length - 1) : Math.max(index - 1, 0);
        choices[next]?.focus(); event.preventDefault(); return;
      }
      if (target instanceof Element && target.closest('.project-picker')) return;
    } else if (target instanceof Element && target.closest('[data-action="toggle-project-picker"]') && event.key === 'ArrowDown') {
      setProjectPicker(true, true); event.preventDefault(); return;
    }
    const menu = root.querySelector<HTMLDetailsElement>('.workflow-menu[open]');
    if (event.key === 'Escape' && menu) {
      menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus();
      event.preventDefault(); return;
    }
    if (target instanceof Element && target.closest('.workflow-menu')) return;
    if (drag) {
      if (event.key === 'Escape') { endDrag(); flushAfterDrag(); event.preventDefault(); }
      return;
    }
    if (event.key === 'Escape') {
      if (createOpen && !pending) { createOpen = false; render(); event.preventDefault(); }
      else if (selectedId) { closeDetail(); event.preventDefault(); }
      else if (query) { query = ''; render(); event.preventDefault(); }
      return;
    }
    if (event.key === 'Tab' && target instanceof HTMLElement) {
      const drawer = target.closest<HTMLElement>('.drawer[aria-modal="true"]');
      if (drawer) {
        const controls = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')).filter((item) => !item.hidden && item.getClientRects().length > 0);
        if (controls.length && ((event.shiftKey && target === controls[0]) || (!event.shiftKey && target === controls[controls.length - 1]))) {
          (event.shiftKey ? controls[controls.length - 1] : controls[0])?.focus(); event.preventDefault(); return;
        }
      }
      const row = target.closest<HTMLElement>('[data-virtual-index]');
      const container = row?.closest<HTMLElement>('[data-window-container]');
      const key = container?.dataset.windowContainer;
      const state = key ? windows.get(key) : undefined;
      if (row && container && key && state) {
        const controls = Array.from(row.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
        const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
        const nextIndex = Number(row.dataset.virtualIndex) + (event.shiftKey ? -1 : 1);
        if (target === edge && nextIndex >= 0 && nextIndex < state.items.length
          && !container.querySelector(`[data-virtual-index="${nextIndex}"]`)) {
          container.scrollTop = state.offsets[nextIndex]!;
          syncWindow(key);
          const nextRow = container.querySelector<HTMLElement>(`[data-virtual-index="${nextIndex}"]`);
          const nextControls = nextRow ? Array.from(nextRow.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')) : [];
          (event.shiftKey ? nextControls[nextControls.length - 1] : nextControls[0])?.focus();
          scheduleWindows(); event.preventDefault(); return;
        }
      }
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable) || createOpen) return;
    if (target instanceof Element && target.closest('[data-form="update"], [data-form="comment"], [data-form="link"]')) return;
    if (event.key === '/') { event.preventDefault(); root.querySelector<HTMLInputElement>('[data-focus="search"]')?.focus(); return; }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); openCreate(); return; }
    if (event.key.toLowerCase() === 'v' && view === 'all') { layout = layout === 'board' ? 'table' : 'board'; render(); }
  }

  function spotlightItem(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const item = target.closest<HTMLElement>('.issue-card, .issue-table__row');
    return item && root.contains(item) ? item : null;
  }
  function onPointerOver(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    const item = spotlightItem(event.target);
    if (item && item !== spotlightItem(event.relatedTarget)) { hoverId = item.dataset.id || ''; applySpotlight(); }
  }
  function onPointerOut(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    const item = spotlightItem(event.target);
    if (item && item !== spotlightItem(event.relatedTarget)) { hoverId = ''; applySpotlight(); }
  }
  function onFocusIn(event: FocusEvent): void {
    const id = spotlightItem(event.target)?.dataset.id || '';
    if (id !== focusId) { focusId = id; if (!rendering) applySpotlight(); }
  }
  function onFocusOut(event: FocusEvent): void {
    const picker = root.querySelector('.project-picker');
    if (!rendering && projectPickerOpen && event.target instanceof Node && picker?.contains(event.target)
      && event.relatedTarget instanceof Node && !picker.contains(event.relatedTarget)) setProjectPicker(false);
    const menu = root.querySelector<HTMLDetailsElement>('.workflow-menu[open]');
    if (!rendering && menu && event.target instanceof Node && menu.contains(event.target)
      && event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget)) menu.open = false;
    const item = spotlightItem(event.target);
    if (item && item !== spotlightItem(event.relatedTarget)) { focusId = ''; applySpotlight(); }
  }

  function dropTransition(issue: Issue, target: Group): { method?: 'claim' | 'close' | 'reopen'; hint: string } {
    const source = groupOf(issue);
    if (source === target) return { hint: t('This issue is already in {group}.', '已经在{group}。', { group: groupLabel(target) }) };
    if (target === 'blocked') return { hint: t("Blocked includes explicit status and dependency-blocked issues. Set the status in Beads or link a dependency.", "阻塞列含状态和依赖。到 Beads 里改状态，或加上依赖。") };
    if (target === 'closed' && issue.status !== 'closed') return { method: 'close', hint: t("Close issue", "关闭") };
    if (source === 'ready' && target === 'active') return { method: 'claim', hint: t("Claim issue", "认领") };
    if (source === 'closed' && target === 'ready') return { method: 'reopen', hint: t("Reopen issue; it may still be blocked", "重新打开，可能仍被阻塞") };
    return { hint: t('Moving from {from} to {to} is not supported.', '不能从{from}移到{to}。', { from: groupLabel(source), to: groupLabel(target) }) };
  }

  function endDrag(): void {
    drag = null;
    for (const card of root.querySelectorAll<HTMLElement>('.issue-card--dragging')) card.classList.remove('issue-card--dragging');
    for (const column of root.querySelectorAll<HTMLElement>('.column[data-drop-group]')) {
      column.classList.remove('column--drop-valid', 'column--drop-invalid', 'column--drop-over');
      const hint = column.querySelector<HTMLElement>('.column__drop-hint');
      if (hint) { hint.hidden = true; hint.textContent = ''; }
    }
  }

  function flushAfterDrag(): void {
    if (disposed || pending || projectLoadTask) return;
    if (projectsReloadPending) { projectsReloadPending = false; void loadProjects(); }
  }

  function onDragEnd(): void {
    endDrag();
    flushAfterDrag();
  }

  function onDragStart(event: DragEvent): void {
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>('.issue-card[data-id]') : null;
    const issue = card ? byId(card.dataset.id || '') : undefined;
    if (!card || !issue || pending || offline() || !event.dataTransfer || event.target instanceof HTMLInputElement) { event.preventDefault(); return; }
    if (loadingSnapshot || loadingProjects || (selectedId && (detailLoading || commentsLoading))) {
      event.preventDefault();
      actionError = t("Wait for the current refresh or issue details to finish before moving this issue.", "等这次刷新或详情加载完再移动。");
      render();
      return;
    }
    drag = { id: issue.id, project: projectId };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', issue.id);
    card.classList.add('issue-card--dragging');
    for (const column of root.querySelectorAll<HTMLElement>('.column[data-drop-group]')) {
      const target = column.dataset.dropGroup as Group;
      const transition = dropTransition(issue, target);
      column.classList.add(transition.method ? 'column--drop-valid' : 'column--drop-invalid');
      const hint = column.querySelector<HTMLElement>('.column__drop-hint');
      if (hint) { hint.textContent = transition.hint; hint.hidden = false; }
    }
  }

  function onDragOver(event: DragEvent): void {
    if (!drag) return;
    const column = event.target instanceof Element ? event.target.closest<HTMLElement>('.column[data-drop-group]') : null;
    if (!column || !root.contains(column)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    for (const other of root.querySelectorAll<HTMLElement>('.column--drop-over')) if (other !== column) other.classList.remove('column--drop-over');
    column.classList.add('column--drop-over');
  }

  function onDragLeave(event: DragEvent): void {
    const column = event.target instanceof Element ? event.target.closest<HTMLElement>('.column[data-drop-group]') : null;
    if (column && !(event.relatedTarget instanceof Node && column.contains(event.relatedTarget))) column.classList.remove('column--drop-over');
  }

  function onDrop(event: DragEvent): void {
    if (!drag) return;
    const column = event.target instanceof Element ? event.target.closest<HTMLElement>('.column[data-drop-group]') : null;
    if (!column || !root.contains(column)) return;
    event.preventDefault();
    const source = drag;
    const issue = source.project === projectId ? byId(source.id) : undefined;
    const target = column.dataset.dropGroup as Group;
    endDrag();
    if (!issue) { actionError = t("The issue or project changed during the drag. Refresh and try again.", "拖动时议题或项目变了。刷新后再试。"); render(); flushAfterDrag(); return; }
    const transition = dropTransition(issue, target);
    if (!transition.method) { actionError = transition.hint; render(); flushAfterDrag(); return; }
    void mutate(transition.method, { id: issue.id });
  }

  function onVisibility(): void {
    if (!document.hidden && !pending && !drag && !refreshTask && !loadingProjects) void loadProjects();
  }
  function onScroll(event: Event): void {
    if (event.target instanceof HTMLElement && event.target.dataset.windowContainer) scheduleWindows();
  }
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('scroll', onScroll, true);
  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointerout', onPointerOut);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragend', onDragEnd);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('pointerdown', onDocumentPointerDown);
  window.addEventListener('resize', onResize);
  let timer = 0;
  function armRefresh(): void {
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      if (!root.isConnected) { cleanup(); return; }
      if (!document.hidden && projectId && !pending && !drag && !refreshTask) void refresh();
    }, refreshMs);
  }
  armRefresh();
  function cleanup(): void {
    disposed = true;
    window.clearInterval(timer);
    if (windowFrame) cancelAnimationFrame(windowFrame);
    if (measureFrame) cancelAnimationFrame(measureFrame);
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('scroll', onScroll, true);
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('pointerout', onPointerOut);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    root.removeEventListener('dragstart', onDragStart);
    root.removeEventListener('dragover', onDragOver);
    root.removeEventListener('dragleave', onDragLeave);
    root.removeEventListener('drop', onDrop);
    root.removeEventListener('dragend', onDragEnd);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    window.removeEventListener('resize', onResize);
  }
  cleanups.set(root, cleanup);
  render();
  void loadProjects();
}
