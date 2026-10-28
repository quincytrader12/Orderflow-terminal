import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Actions, DockLocation, ICloseType, Layout, Model, type BorderNode, type IJsonModel, type ILayoutApi, type TabNode } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';
import { startAlerts, useToasts } from '../alerts/engine';
import { startAmtService } from '../desktop/amt';
import { CommandCenter } from '../command/CommandCenter';
import { startSwarmService } from '../meme/swarm/swarm';
import { startReportScheduler } from '../desktop/reports';
import { startTelegramService } from '../desktop/telegram';
import { startCollectors } from '../market/collectors';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { applyTheme } from '../ui/theme';
import { loadLayout, PRESETS, sanitize, saveLayout, tab } from './layouts';
import { AddPanelModal, ConnectionModal, LayoutsModal, SettingsModal, type Placement } from './Modals';
import { KeysModal } from './KeysModal';
import { PanelHost } from './PanelHost';
import { TopBar, type ModalKind } from './TopBar';

export function useThemeAttr() {
  const theme = useSettings((s) => s.theme);
  const filter = useSettings((s) => s.filter);
  const glass = useSettings((s) => s.glass);
  useLayoutEffect(() => applyTheme(theme, filter, glass), [theme, filter, glass]);
}

function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
          <b>{t.title}</b>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  useThemeAttr();
  const [model, setModel] = useState(() => Model.fromJson(loadLayout()));
  const [modal, setModal] = useState<ModalKind>(null);
  const layoutRef = useRef<ILayoutApi>(null);
  const fired = useSettings((s) => s.fired);
  const view = useSettings((s) => s.view);
  const sessionStart = useMemo(() => Date.now(), []);

  useEffect(() => {
    hub();
    startCollectors();
    startAlerts();
    startTelegramService();
    startAmtService();
    startSwarmService();
    startReportScheduler();
  }, []);

  // panels ask for the Connections window through a window event
  useEffect(() => {
    const open = () => setModal('keys');
    window.addEventListener('novus:connect', open);
    return () => window.removeEventListener('novus:connect', open);
  }, []);

  const applyLayout = useCallback((json: IJsonModel) => {
    const m = Model.fromJson(sanitize(json));
    saveLayout(m.toJson());
    setModel(m);
  }, []);

  // outside edit mode tabs can't be dragged or docked (no accidental
  // rearranging); every panel can always be closed with its ×, and the gaps
  // between panels always stay resizable
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const on = editing;
    model.doAction(Actions.updateModelAttributes({ tabEnableDrag: on, tabSetEnableDrag: on, tabSetEnableDrop: on, tabEnableClose: true, tabCloseType: ICloseType.Always, tabSetEnableDivide: on }));
  }, [model, editing]);

  /** Maximise (or restore) the tabset holding the main chart. */
  const focusChart = useCallback(() => {
    let target: string | undefined;
    for (const comp of ['footprint', 'historical', 'heatmap'])
      model.visitNodes((n) => {
        if (!target && n.getType() === 'tab' && (n as TabNode).getComponent() === comp) target = n.getParent()?.getId();
      });
    if (target) model.doAction(Actions.maximizeToggle(target));
  }, [model]);

  /** Add a panel to the active area, a new column/row at an edge, or a dock edge. */
  const addPanel = (id: string, where: Placement = 'active') => {
    const json = tab(id);
    const l = layoutRef.current;
    if (!l) return;
    const edge = { left: DockLocation.LEFT, right: DockLocation.RIGHT, bottom: DockLocation.BOTTOM } as const;
    if (where === 'left' || where === 'right' || where === 'bottom') {
      model.doAction(Actions.addNode(json, model.getRootRow()!.getId(), edge[where], -1, true));
      return;
    }
    if (where.startsWith('dock-')) {
      const loc = edge[where.slice(5) as keyof typeof edge];
      let border: BorderNode | undefined;
      model.visitNodes((n) => {
        if (!border && n.getType() === 'border' && (n as BorderNode).getLocation() === loc) border = n as BorderNode;
      });
      if (border) {
        model.doAction(Actions.addNode(json, border.getId(), DockLocation.CENTER, -1, true));
        return;
      }
    }
    if (!l.addTabToActiveTabSet(json)) {
      const first = model.getFirstTabSet();
      if (first) l.addTabToTabSet(first.getId(), json);
    }
  };

  /** Show a panel: select its tab if it is already in the layout, otherwise add it as a new column. */
  const openPanel = (component: string) => {
    let found: string | undefined;
    model.visitNodes((n) => {
      if (!found && n.getType() === 'tab' && (n as TabNode).getComponent() === component) found = n.getId();
    });
    if (found) model.doAction(Actions.selectTab(found));
    else addPanel(component, 'right');
  };

  const factory = useCallback((node: TabNode) => <PanelHost node={node} model={model} />, [model]);

  return (
    <div className={`app${editing ? ' editing' : ''}`}>
      <div className="app-bg" aria-hidden>
        <i className="blob b1" />
        <i className="blob b2" />
        <i className="blob b3" />
      </div>
      <TopBar onOpen={setModal} onFocusChart={focusChart} onOpenPanel={openPanel} alertCount={fired.filter((f) => f.time >= sessionStart).length} editing={editing} onEdit={() => setEditing(!editing)} />
      {editing && (
        <div className="edit-bar" role="region" aria-label="Layout editing">
          <b>✎ Editing layout</b>
          <span className="tips" title="Drag a panel by its tab: drop it on the middle of another panel to stack them, or on a highlighted edge to split. Drag the gaps between panels to resize. × on a tab closes it; double-click a tab bar to maximise.">
            <kbd>drag a tab</kbd> move · drop on an edge to split · <kbd>drag a gap</kbd> resize · <kbd>×</kbd> close · <kbd>double-click</kbd> tab bar to maximise
          </span>
          <button className="btn ghost" onClick={() => setModal('add')}>
            + Add panel
          </button>
          <button className="btn ghost" onClick={() => setModal('layouts')}>
            ▦ Layouts
          </button>
          <button className="btn ghost" onClick={() => confirm('Reset to the default layout? Your current arrangement is replaced (save it in Layouts first if you want to keep it).') && applyLayout(PRESETS[0].build())}>
            Reset
          </button>
          <button className="btn" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}
      {view === 'command' && <CommandCenter />}
      {/* the panels stay mounted under the Command Center, so they keep their state */}
      <div className="layout-host" style={view === 'command' ? { display: 'none' } : undefined}>
        <div className="layout-inner">
          <Layout ref={layoutRef} model={model} factory={factory} onModelChange={(m) => saveLayout(m.toJson())} realtimeResize />
        </div>
      </div>
      {modal === 'connection' && <ConnectionModal onClose={() => setModal(null)} />}
      {modal === 'layouts' && <LayoutsModal onClose={() => setModal(null)} onApply={applyLayout} current={() => model.toJson()} />}
      {modal === 'add' && <AddPanelModal onClose={() => setModal(null)} onAdd={addPanel} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'keys' && <KeysModal onClose={() => setModal(null)} onOpenPanel={openPanel} />}
      <Toasts />
    </div>
  );
}
