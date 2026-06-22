import { useCallback, useSyncExternalStore } from 'react';

import { useStoreApi } from './useStore';
import type { Edge } from '../types';

/*
 * Per-edge subscription used by EdgeWrapper, mirroring useNode. Each edge subscribes only to itself
 * via the store's per-edge registry, so it re-renders when its own object changes (setEdges wakes it)
 * or when one of its endpoint nodes moves (incidentEdges), not on every store emit.
 */
export function useEdge<EdgeType extends Edge = Edge>(id: string): EdgeType {
  const store = useStoreApi();

  const getVersion = useCallback(() => store.getState().getEdgeVersion(id), [store, id]);
  useSyncExternalStore(
    useCallback((onChange) => store.getState().subscribeEdge(id, onChange), [store, id]),
    getVersion,
    getVersion // getServerSnapshot: the version is environment-agnostic, so SSR is safe
  );

  // EdgeWrapper only renders ids present in edgeLookup, so the edge is guaranteed here
  return store.getState().edgeLookup.get(id)! as EdgeType;
}
