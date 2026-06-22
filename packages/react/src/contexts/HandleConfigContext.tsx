import { createContext, useContext, type ReactNode } from 'react';
import { shallow } from 'zustand/shallow';
import { ConnectionMode } from '@xyflow/system';

import { useStore } from '../hooks/useStore';
import type { ReactFlowState } from '../types';

/*
 * Static per-flow config consumed by every Handle (connectOnClick / noPanClassName / rfId /
 * connectionMode). Reading these through a per-handle useStore selector meant every handle re-ran
 * it on every store emit (e.g. each node-drag frame). The provider subscribes once and hands them
 * down, so N handle subscriptions collapse to 1 with no staleness (context updates on real change).
 */
export type HandleConfig = {
  connectOnClick: boolean;
  noPanClassName: string;
  rfId: string;
  connectionMode: ConnectionMode;
};

const defaultHandleConfig: HandleConfig = {
  connectOnClick: true,
  noPanClassName: 'nopan',
  rfId: '1',
  connectionMode: ConnectionMode.Strict,
};

const HandleConfigContext = createContext<HandleConfig>(defaultHandleConfig);

const selector = (s: ReactFlowState): HandleConfig => ({
  connectOnClick: s.connectOnClick,
  noPanClassName: s.noPanClassName,
  rfId: s.rfId,
  connectionMode: s.connectionMode,
});

export function HandleConfigProvider({ children }: { children: ReactNode }) {
  const config = useStore(selector, shallow);
  return <HandleConfigContext.Provider value={config}>{children}</HandleConfigContext.Provider>;
}

export function useHandleConfig(): HandleConfig {
  return useContext(HandleConfigContext);
}
