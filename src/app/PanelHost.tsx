import { Component, useCallback, useRef, useState, type ReactNode } from 'react';
import { Actions, type Model, type TabNode } from 'flexlayout-react';
import { PANEL_MAP } from '../panels/registry';

class PanelErrorBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[panel ${this.props.name}]`, error);
  }
  render() {
    if (this.state.error)
      return (
        <div className="empty">
          {this.props.name} crashed: {this.state.error.message}
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={() => this.setState({ error: null })}>
              Reload panel
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

/** Hosts a panel inside a layout tab; per-instance config lives on the tab node. */
export function PanelHost({ node, model }: { node: TabNode; model: Model }) {
  const def = PANEL_MAP[node.getComponent() ?? ''];
  const [config, setLocal] = useState<Record<string, unknown>>(() => ({ ...(def?.defaults ?? {}), ...(node.getConfig() ?? {}) }));
  const latest = useRef(config);
  latest.current = config;
  const setConfig = useCallback(
    (patch: Record<string, unknown>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setLocal(next);
      model.doAction(Actions.updateNodeAttributes(node.getId(), { config: next }));
    },
    [model, node],
  );
  if (!def) return <div className="empty">Unknown panel “{node.getComponent()}”</div>;
  const C = def.component;
  return (
    <PanelErrorBoundary name={def.title}>
      <C config={config} setConfig={setConfig} nodeId={node.getId()} />
    </PanelErrorBoundary>
  );
}
