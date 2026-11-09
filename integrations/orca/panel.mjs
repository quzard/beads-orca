import { mount } from '../../src/ui/index.ts';
import { panelLocaleTag, syncPanelLocale } from '../../src/ui/i18n.ts';
import { createPanelTransport } from '../../src/orca/panel-transport.ts';

syncPanelLocale();
const inner = createPanelTransport({
  async call(method, params) {
    const host = window.orca?.host;
    if (!host) throw new Error('Open the Beads panel in Orca to connect to the plugin.');
    return host.call(method, params);
  },
});
const transport = {
  dispose: () => inner.dispose(),
  request: (request, options) => {
    syncPanelLocale();
    return inner.request({ ...request, locale: panelLocaleTag() }, options);
  },
};
window.addEventListener('pagehide', () => transport.dispose(), { once: true });

const root = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
mount(root, transport);
