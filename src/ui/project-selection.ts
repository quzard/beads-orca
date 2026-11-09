export type ProjectChoice = { id: string; current?: boolean };

/**
 * On open, follow Orca's focused workspace when exactly one row is marked current.
 * The last manual choice is only a fallback when that focus is missing or ambiguous.
 */
export function preferredProjectId(projects: readonly ProjectChoice[], remembered: string, previous: string): string {
  const current = projects.filter((project) => project.current === true);
  if (current.length === 1) return current[0].id;
  if (remembered && projects.some((project) => project.id === remembered)) return remembered;
  if (previous && projects.some((project) => project.id === previous)) return previous;
  return projects[0]?.id ?? '';
}

export type FocusWorkspace = {
  id: string;
  name: string;
  path: string;
  hostId?: string | null;
  branch?: string | null;
};

export type FocusContext = {
  displayName?: string;
  branch?: string;
  path?: string;
  hostId?: string | null;
  terminals?: ReadonlyArray<{ title?: string }>;
};

function branchKey(branch: string | null | undefined): string {
  return (branch ?? '').replace(/^refs\/heads\//, '');
}

function pathKey(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed || '/';
}

function hostKey(hostId: string | null | undefined): string {
  return !hostId || hostId === 'local' ? 'local' : hostId;
}

function basenameOf(path: string): string {
  const normalized = pathKey(path);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** Absolute paths mentioned in a terminal title, such as `user@host:/sls/wt/app`. */
export function pathsInTitle(title: string): string[] {
  const found: string[] = [];
  for (const match of title.matchAll(/(?:^|[\s:@])(\/(?:[^ \t\r\n])+)/g)) {
    found.push(pathKey(match[1]));
  }
  return found;
}

function samePlace(workspace: FocusWorkspace, path: string, hostId?: string | null): boolean {
  if (pathKey(workspace.path) !== pathKey(path)) return false;
  if (hostId === undefined || hostId === null || hostId === '') return true;
  return hostKey(workspace.hostId) === hostKey(hostId);
}

/**
 * The focused Orca workspace. `readContext` only gives a name and branch, so a
 * terminal title path breaks a tie between a local folder and the SSH worktree.
 */
export function focusedWorkspaceId(workspaces: readonly FocusWorkspace[], context: FocusContext | null | undefined): string | undefined {
  if (!context) return undefined;
  if (context.path) {
    const byPath = workspaces.filter((workspace) => samePlace(workspace, context.path!, context.hostId));
    if (byPath.length === 1) return byPath[0].id;
  }
  const branch = branchKey(context.branch);
  const named = context.displayName
    ? workspaces.filter((workspace) => workspace.name === context.displayName && branchKey(workspace.branch) === branch)
    : [];
  const titlePaths = (context.terminals ?? []).flatMap((terminal) => terminal.title ? pathsInTitle(terminal.title) : []);
  const narrowed = (rows: readonly FocusWorkspace[]): FocusWorkspace | undefined => {
    if (titlePaths.length) {
      const byTitle = rows.filter((workspace) => titlePaths.some((path) => samePlace(workspace, path)));
      if (byTitle.length === 1) return byTitle[0];
    }
    return rows.length === 1 ? rows[0] : undefined;
  };
  const namedHit = narrowed(named);
  if (namedHit) return namedHit.id;
  if (!context.displayName) return undefined;
  const byBasename = workspaces.filter((workspace) => basenameOf(workspace.path) === context.displayName && branchKey(workspace.branch) === branch);
  return narrowed(byBasename)?.id;
}
