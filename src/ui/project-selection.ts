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
