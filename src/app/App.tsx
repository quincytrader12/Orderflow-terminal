import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layout, Model, type IJsonModel, type ILayoutApi, type TabNode } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';
import { startAlerts, useToasts } from '../alerts/engine';
import { startCollectors } from '../market/collectors';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { loadLayout, sanitize, saveLayout, tab } from './layouts';
import { AddPanelModal, ConnectionModal, LayoutsModal, SettingsModal } from './Modals';
import { PanelHost } from './PanelHost';
import { TopBar, type ModalKind } from './TopBar';

export function useThemeAttr() {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
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
  }, []);

  const applyLayout = useCallback((json: IJsonModel) => {
    const m = Model.fromJson(sanitize(json));
    saveLayout(m.toJson());
    setModel(m);
  }, []);

  const addPanel = (id: string) => {
    const json = tab(id);
    const l = layoutRef.current;
    if (!l) return;
    if (!l.addTabToActiveTabSet(json)) {
      const first = model.getFirstTabSet();
      if (first) l.addTabToTabSet(first.getId(), json);
    }
  };

  const factory = useCallback((node: TabNode) => <PanelHost node={node} model={model} />, [model]);

  return (
    <div className="app">
      <TopBar onOpen={setModal} alertCount={fired.filter((f) => f.time >= sessionStart).length} />
      <div className="layout-host">
        <Layout ref={layoutRef} model={model} factory={factory} onModelChange={(m) => saveLayout(m.toJson())} realtimeResize />
      </div>
      {modal === 'connection' && <ConnectionModal onClose={() => setModal(null)} />}
      {modal === 'layouts' && <LayoutsModal onClose={() => setModal(null)} onApply={applyLayout} current={() => model.toJson()} />}
      {modal === 'add' && <AddPanelModal onClose={() => setModal(null)} onAdd={addPanel} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      <Toasts />
    </div>
  );
}
