/** 面板和 worker 各打进一份。没带 locale 的请求保持英文，现有测试不用改断言。 */
export type UiLocale = 'en' | 'zh-CN';

let current: UiLocale = 'en';

export function useLocale(locale: UiLocale): void {
  current = locale;
}

export function currentLocale(): UiLocale {
  return current;
}

/** Orca 面板上的 `orca.locale` 是界面语言。繁体没有译文时退回英文。 */
export function localeFromTag(tag: string | undefined | null, fallback: UiLocale): UiLocale {
  if (!tag || tag.length > 128) return fallback;
  const value = tag.trim().toLowerCase().replace(/_/g, '-');
  if (value === 'zh' || value.startsWith('zh-cn') || value.startsWith('zh-hans') || value.startsWith('zh-sg')) return 'zh-CN';
  if (value.startsWith('zh-tw') || value.startsWith('zh-hk') || value.startsWith('zh-mo') || value.startsWith('zh-hant')) return 'en';
  if (value.startsWith('zh')) return 'zh-CN';
  if (value.startsWith('en')) return 'en';
  return 'en';
}

export function t(en: string, zh: string, vars?: Record<string, string | number>): string {
  const template = current === 'zh-CN' ? zh : en;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => vars[name] === undefined ? `{${name}}` : String(vars[name]));
}

/** 设置页由 Orca 直接渲染清单，只有一条文案。英文留在这里，清单用中文。 */
export const settingsCopy = {
  en: {
    projectPathsTitle: 'Additional local Beads project paths',
    projectPathsDescription: 'One absolute directory per line. Orca workspaces are included automatically. SSH workspaces use the Orca host name as a ~/.ssh/config alias.',
    remoteHostsTitle: 'Remote Beads SSH connections',
    remoteHostsDescription: 'Optional override of the automatic SSH alias. JSON mapping Orca host IDs to {destination, configFile?, name?}. destination replaces the host name from Orca; configFile is an optional absolute SSH config path; name is a portable display label. Leave empty when the Orca SSH host name is already the ~/.ssh/config Host alias. Never store credentials here.',
    remotePathTitle: 'Remote PATH for bd and python3',
    remotePathDescription: 'Colon-separated directories searched on the Linux host before the SSH default PATH. Tilde is expanded. Leave empty for ~/.local/bin, ~/bin, and /usr/local/bin. Commands run in bash --noprofile --norc, not the login shell.',
    refreshTitle: 'Board refresh interval (seconds)',
    refreshDescription: 'How often a visible panel reloads. Leave empty for 15 seconds on local projects and 60 seconds when any remote host is configured. Allowed range is 5 to 300.',
    timeoutTitle: 'bd and SSH command timeout (seconds)',
    timeoutDescription: 'Budget for one Beads request, including every SSH call it makes. Leave empty for 30 seconds locally and 60 seconds over SSH. Allowed range is 5 to 110.',
  },
  'zh-CN': {
    projectPathsTitle: '附加的本地 Beads 项目路径',
    projectPathsDescription: '每行一个绝对路径。Orca 工作区会自动加入。SSH 工作区把 Orca 主机名当作 ~/.ssh/config 的 Host 别名。',
    remoteHostsTitle: '远程 Beads SSH 连接',
    remoteHostsDescription: '可选，用来覆盖自动识别的 SSH 别名。JSON 把 Orca hostId 映射为 {destination, configFile?, name?}。destination 替换 Orca 里的主机名；configFile 是桌面上可选的绝对 SSH 配置路径；name 是筛选器用的显示名。主机名已经是 ~/.ssh/config 的 Host 别名时留空。不要在这里存放凭据。',
    remotePathTitle: '远端 bd 和 python3 的 PATH',
    remotePathDescription: '在 Linux 主机上、SSH 默认 PATH 之前搜索的目录，用冒号分隔。支持波浪号。留空则使用 ~/.local/bin、~/bin 和 /usr/local/bin。命令在 bash --noprofile --norc 里运行，不经过登录 shell。',
    refreshTitle: '看板刷新间隔（秒）',
    refreshDescription: '可见面板多久重新加载一次。留空时本地项目 15 秒，配置了远程主机时 60 秒。允许 5 到 300。',
    timeoutTitle: 'bd 和 SSH 命令超时（秒）',
    timeoutDescription: '一次 Beads 请求的时间预算，包含其中每一次 SSH 调用。留空时本地 30 秒，SSH 60 秒。允许 5 到 110。',
  },
} as const;

export function syncPanelLocale(): UiLocale {
  const orca = (globalThis as { orca?: { locale?: string } }).orca;
  // 没有 Orca 语言时默认简体中文。不用 navigator.language，它跟的是系统而不是 Orca。
  const locale = localeFromTag(orca?.locale, 'zh-CN');
  current = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
  return locale;
}

export function panelLocaleTag(): string {
  return current;
}

export function hostLabel(name: string | null | undefined): string {
  if (!name || name === 'local' || name === 'Local') return t('Local', '本机');
  return name;
}

/** 只改显示。交给 bd 的值仍是英文键。 */
export function typeLabel(type: string): string {
  switch (type) {
    case 'task': return t('task', '任务');
    case 'bug': return t('bug', '缺陷');
    case 'feature': return t('feature', '功能');
    case 'chore': return t('chore', '杂项');
    case 'epic': return t('epic', '史诗');
    case 'decision': return t('decision', '决策');
    case 'spike': return t('spike', '预研');
    case 'story': return t('story', '故事');
    case 'milestone': return t('milestone', '里程碑');
    default: return type;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'open': return t('Open', '未解决');
    case 'in_progress': return t('In progress', '进行中');
    case 'blocked': return t('Blocked', '阻塞');
    case 'deferred': return t('Deferred', '推迟');
    case 'closed': return t('Closed', '已关闭');
    default: return status;
  }
}

export function relationLabel(type: string): string {
  switch (type) {
    case 'blocks': return t('blocks', '阻塞');
    case 'parent-child': return t('parent-child', '父子');
    case 'related': return t('related', '相关');
    case 'discovered-from': return t('discovered-from', '发现自');
    default: return type;
  }
}

export function modeLabel(mode: string): string {
  if (mode === 'implementation') return t('implementation', '实现');
  if (mode === 'research') return t('research', '研究');
  return mode;
}

export function deliveryLabel(value: string): string {
  switch (value) {
    case 'draft': return t('draft', '草稿');
    case 'handed-to-terminal': return t('handed-to-terminal', '已发到终端');
    case 'journaled': return t('journaled', '已记录');
    case 'rejected': return t('rejected', '已拒绝');
    case 'unknown': return t('unknown', '未知');
    default: return value;
  }
}

export function outcomeLabel(value: string): string {
  switch (value) {
    case 'completed': return t('completed', '完成');
    case 'partial': return t('partial', '做了一部分');
    case 'blocked': return t('blocked', '阻塞');
    case 'not-started': return t('not-started', '没开始');
    case 'published': return t('published', '已写入');
    case 'unknown': return t('unknown', '未知');
    default: return value;
  }
}

export function scopeLabel(scope: string): string {
  if (scope === 'personal') return t('personal', '个人');
  if (scope === 'project') return t('project', '项目');
  return scope;
}
