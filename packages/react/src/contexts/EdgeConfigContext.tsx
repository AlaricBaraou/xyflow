import { createContext, useContext, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';
import { ConnectionMode, type ZIndexMode } from '@xyflow/system';

import { useStore } from '../hooks/useStore';
import type { DefaultEdgeOptions, ReactFlowState } from '../types';

/*
 * Static per-flow config consumed by every EdgeWrapper (defaultEdgeOptions / connectionMode /
 * elevateEdgesOnSelect / zIndexMode). Reading these through a per-edge useStore selector meant every
 * edge re-ran it on every store emit (e.g. each node-drag frame). The provider subscribes once and
 * hands them down, so N edge config subscriptions collapse to 1 with no staleness (context updates
 * on real change).
 */
export type EdgeConfig = {
  defaultEdgeOptions: DefaultEdgeOptions | undefined;
  connectionMode: ConnectionMode;
  elevateEdgesOnSelect: boolean;
  zIndexMode: ZIndexMode;
};

const defaultEdgeConfig: EdgeConfig = {
  defaultEdgeOptions: undefined,
  connectionMode: ConnectionMode.Strict,
  elevateEdgesOnSelect: true,
  zIndexMode: 'basic',
};

const EdgeConfigContext = createContext<EdgeConfig>(defaultEdgeConfig);

const selector = (s: ReactFlowState): EdgeConfig => ({
  defaultEdgeOptions: s.defaultEdgeOptions,
  connectionMode: s.connectionMode,
  elevateEdgesOnSelect: s.elevateEdgesOnSelect,
  zIndexMode: s.zIndexMode,
});

export function EdgeConfigProvider({ children }: { children: ReactNode }) {
  const config = useStore(selector, shallow);
  return <EdgeConfigContext.Provider value={config}>{children}</EdgeConfigContext.Provider>;
}

export function useEdgeConfig(): EdgeConfig {
  return useContext(EdgeConfigContext);
}
