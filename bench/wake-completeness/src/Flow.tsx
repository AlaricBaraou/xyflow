import { memo, useEffect } from 'react';
import {
  Handle,
  Position,
  ReactFlow,
  useStoreApi,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowState,
} from '@xyflow/react';
import type { StoreApi } from 'zustand';

export type RFStore = StoreApi<ReactFlowState>;

// a plain custom node (no handles)
const BenchNode = memo(function BenchNode({ data }: NodeProps) {
  return <div className="bench-node">{(data as { label?: string }).label}</div>;
});

// a node with real source/target handles, so edges have endpoints and render
const HandleNode = memo(function HandleNode({ data }: NodeProps) {
  return (
    <div className="bench-node">
      <Handle type="target" position={Position.Left} />
      {(data as { label?: string }).label}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { bench: BenchNode, handle: HandleNode };

// hands the store's StoreApi back to the verifier so it can subscribe probes and drive actions
function Capture({ onReady }: { onReady: (store: RFStore) => void }) {
  const store = useStoreApi() as unknown as RFStore;
  useEffect(() => {
    onReady(store);
  }, [store, onReady]);
  return null;
}

export function Flow({
  nodes,
  edges,
  onReady,
}: {
  nodes: Node[];
  edges?: Edge[];
  onReady: (store: RFStore) => void;
}) {
  return (
    <ReactFlow
      defaultNodes={nodes}
      defaultEdges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      panOnDrag={false}
      zoomOnScroll={false}
      proOptions={{ hideAttribution: true }}
    >
      <Capture onReady={onReady} />
    </ReactFlow>
  );
}
