import type { RpcRequest, Snapshot } from '../shared.js';
import { localeFromTag, t, useLocale } from '../ui/i18n.js';
import { ProjectAccess, type ProductHost } from './projects.js';
import { LibraryService } from './library.js';
import { WorkflowService } from './workflow.js';
import { createReplyHandler } from './reply-transfer.js';

interface OrcaHost extends ProductHost {
  panels: { handle(name: string, handler: (input: unknown) => Promise<unknown>): void };
}

export default function activate(orca: OrcaHost): void {
  const access = new ProjectAccess(orca);
  const library = new LibraryService(orca, access);
  const workflow = new WorkflowService(orca, access, library);
  orca.panels.handle('beads', createReplyHandler(async (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Beads request.');
    const request = input as RpcRequest;
    if (typeof request.method !== 'string') throw new Error('A Beads request method is required.');
    useLocale(localeFromTag(request.locale, 'en'));
    const response = await (workflow.handles(request.method) ? workflow.request(request)
      : library.handles(request.method) ? library.request(request)
        : access.request(request));
    if (request.method === 'snapshot') {
      const snapshot = response as Snapshot;
      await orca.host.call('statusBar.update', {
        id: 'queue', text: snapshot.offline ? t('Beads offline', 'Beads 离线') : `Beads ${snapshot.readyIds.length}`,
        tone: snapshot.offline ? 'warning' : 'neutral',
        tooltip: t(
          '{name}: {offline}{ready} ready · {blocked} blocked · updated {at}',
          '{name}：{offline}就绪 {ready} · 阻塞 {blocked} · 更新于 {at}',
          {
            name: snapshot.project.name,
            offline: snapshot.offline ? t('offline snapshot · ', '离线快照 · ') : '',
            ready: snapshot.readyIds.length,
            blocked: snapshot.blockedIds.length,
            at: snapshot.fetchedAt,
          },
        ),
      });
    }
    return response;
  }));
}
