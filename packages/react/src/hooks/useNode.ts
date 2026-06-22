import { useCallback, useSyncExternalStore } from 'react';

import { useStoreApi } from './useStore';
import type { InternalNode, Node } from '../types';

/*
 * Per-node subscription used by NodeWrapper. Instead of a global notify-all `useStore` selector
 * (which re-runs for every mounted node on every store emit), each node subscribes only to itself
 * via the store's per-node registry, so a single-node change wakes only that node.
 *
 * The subscription is a per-node version counter that the store bumps when the node's internalNode
 * reference changes or its parent status (`parentLookup.has`) changes. The parent-status part keeps
 * `isParent` reactive when a child gains or loses `parentId`, which doesn't change the parent's own
 * reference.
 */

export type NodeRenderSlice<NodeType extends Node = Node> = {
  node: InternalNode<NodeType>;
  internals: InternalNode<NodeType>['internals'];
  isParent: boolean;
};

export function useNode<NodeType extends Node = Node>(id: string): NodeRenderSlice<NodeType> {
  const store = useStoreApi();

  const getVersion = useCallback(() => store.getState().getNodeVersion(id), [store, id]);
  useSyncExternalStore(
    useCallback((onChange) => store.getState().subscribeNode(id, onChange), [store, id]),
    getVersion,
    getVersion // getServerSnapshot: the version is environment-agnostic, so SSR is safe
  );

  // NodeWrapper only renders ids present in nodeLookup, so the node is guaranteed here
  const { nodeLookup, parentLookup } = store.getState();
  const node = nodeLookup.get(id)! as InternalNode<NodeType>;
  // cast works around a generic-variance quirk in InternalNode<NodeType>['internals']
  return { node, internals: node.internals, isParent: parentLookup.has(id) } as NodeRenderSlice<NodeType>;
}
