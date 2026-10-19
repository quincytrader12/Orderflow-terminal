import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Actions, DockLocation, Layout, Model, type BorderNode, type IJsonModel, type ILayoutApi, type TabNode } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';
import { startAlerts, useToasts } from '../alerts/engine';
import { startTelegramService } from '../desktop/telegram';
import { startCollectors } from '../market/collectors';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { applyTheme } from '../ui/theme';
import { loadLayout, sanitize, saveLayout, tab } from './layouts';
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
  const sessionStart = useMemo(() => Date.now(), []);

  useEffect(() => {
    hub();
    startCollectors();
    startAlerts();
    startTelegramService();
  }, []);

  const applyLayout = useCallback((json: IJsonModel) => {
    const m = Model.fromJson(sanitize(json));
    saveLayout(m.toJson());
    setModel(m);
  }, []);

  // lock: tabs can't be dragged, docked or closed; splits stay resizable
  const locked = useSettings((s) => s.layoutLocked);
  useEffect(() => {
    model.doAction(Actions.updateModelAttributes({ tabEnableDrag: !locked, tabSetEnableDrag: !locked, tabSetEnableDrop: !locked, tabEnableClose: !locked, tabSetEnableDivide: !locked }));
  }, [model, locked]);

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

  const factory = useCallback((node: TabNode) => <PanelHost node={node} model={model} />, [model]);

  return (
    <div className="app">
      <div className="app-bg" aria-hidden>
        <i className="blob b1" />
        <i className="blob b2" />
        <i className="blob b3" />
      </div>
      <TopBar onOpen={setModal} onFocusChart={focusChart} alertCount={fired.filter((f) => f.time >= sessionStart).length} />
      <div className="layout-host">
        <div className="layout-inner">
          <Layout ref={layoutRef} model={model} factory={factory} onModelChange={(m) => saveLayout(m.toJson())} realtimeResize />
        </div>
      </div>
      {modal === 'connection' && <ConnectionModal onClose={() => setModal(null)} />}
      {modal === 'layouts' && <LayoutsModal onClose={() => setModal(null)} onApply={applyLayout} current={() => model.toJson()} />}
      {modal === 'add' && <AddPanelModal onClose={() => setModal(null)} onAdd={addPanel} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'keys' && <KeysModal onClose={() => setModal(null)} />}
      <Toasts />
    </div>
  );
}
