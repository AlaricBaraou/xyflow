/*
 * Wake-completeness verifier, FULL channel set (runs on the all-fanout branch, which has every
 * channel the stack introduces: per-node, per-edge object, node-list, edge-list, selection,
 * connection, plus patchNodes).
 *
 * Two properties, both proven per mutation:
 *   - COMPLETENESS (correctness): if a subscriber's rendered value actually changed, its channel
 *     fired. A miss = silent stale UI. This is the invariant zustand's broadcast gives for free and
 *     the keyed channels have to earn.
 *   - TIGHTNESS (the perf claim): a flat position-only drag must NOT wake the coarse channels
 *     (node-list / edge-list / selection / connection). If it did, the renderers/SelectionListener
 *     would recompute every frame and the optimization would be moot. This is asserted only where
 *     the cheap path is guaranteed (flat graph, position-only), so conservative full-rebuild wakes
 *     elsewhere are reported as spurious, not failures.
 *
 * Ground truth is by reference, matching each channel's own bump trigger (the immutable-swap
 * invariant): node = internalNode ref + parent status; edge = edge object ref + both endpoint
 * internalNode refs; node/edge list = the id-key order; selection = the selected id sets;
 * connection = the connection state + click-start handle refs. Removed ids are excluded (their
 * wrapper unmounts; the channel deliberately does not wake them).
 */
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { applyNodeChanges, applyEdgeChanges, type Edge, type Node, type NodeChange, type EdgeChange } from '@xyflow/react';
import { Flow, type RFStore } from './Flow';

const sceneEl = () => document.getElementById('scene')!;
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const waitNodes = async (n: number) => {
  for (let i = 0; i < 3000; i++) {
    if (sceneEl().querySelectorAll('.react-flow__node').length >= n) {
      await raf();
      return;
    }
    await raf();
  }
};

type Violation = { step: string; kind: string; id: string; detail: string };

// ---- reference snapshots (match the channels' bump triggers) ----
const snapNode = (s: RFStore, id: string) => {
  const st = s.getState();
  return { present: st.nodeLookup.has(id), ref: st.nodeLookup.get(id), isParent: st.parentLookup.has(id) };
};
type NodeSnap = ReturnType<typeof snapNode>;
const nodeChanged = (a: NodeSnap, b: NodeSnap) => a.ref !== b.ref || a.isParent !== b.isParent;

const snapEdge = (s: RFStore, e: Edge) => {
  const st = s.getState();
  return {
    present: st.edgeLookup.has(e.id),
    ref: st.edgeLookup.get(e.id),
    srcRef: st.nodeLookup.get(e.source),
    tgtRef: st.nodeLookup.get(e.target),
  };
};
type EdgeSnap = ReturnType<typeof snapEdge>;
const edgeChanged = (a: EdgeSnap, b: EdgeSnap) => a.ref !== b.ref || a.srcRef !== b.srcRef || a.tgtRef !== b.tgtRef;

const nodeIdList = (s: RFStore) => [...s.getState().nodeLookup.keys()].join('|');
const edgeIdList = (s: RFStore) => [...s.getState().edgeLookup.keys()].join('|');
const selectionSig = (s: RFStore) => {
  const st = s.getState();
  const ns = [...st.nodeLookup.values()].filter((n) => n.selected).map((n) => n.id).sort().join(',');
  const es = [...st.edgeLookup.values()].filter((e) => e.selected).map((e) => e.id).sort().join(',');
  return `N[${ns}]E[${es}]`;
};
const connectionSig = (s: RFStore) => {
  const st = s.getState() as unknown as { connection: unknown; connectionClickStartHandle: unknown };
  return { conn: st.connection, clickStart: st.connectionClickStartHandle };
};
const connChanged = (a: ReturnType<typeof connectionSig>, b: ReturnType<typeof connectionSig>) =>
  a.conn !== b.conn || a.clickStart !== b.clickStart;

type Fired = {
  nodes: Set<string>;
  edges: Set<string>;
  nodesList: boolean;
  edgesList: boolean;
  selection: boolean;
  connection: boolean;
};
// `false` = must NOT fire (tightness), `true` = must fire, undefined = only completeness
type Expect = { nodesList?: boolean; edgesList?: boolean; selection?: boolean; connection?: boolean };

async function mount(nodes: Node[], edges: Edge[]) {
  let store: RFStore | null = null;
  const root = createRoot(sceneEl());
  root.render(createElement(Flow, { nodes, edges, onReady: (s: RFStore) => (store = s) }));
  await waitNodes(nodes.length);
  for (let i = 0; i < 200 && !store; i++) await raf();
  if (!store) throw new Error('store not captured');

  const s = store as RFStore;
  const fired: Fired = { nodes: new Set(), edges: new Set(), nodesList: false, edgesList: false, selection: false, connection: false };
  const unsubs: Array<() => void> = [];
  const nodeIds = nodes.map((n) => n.id);
  for (const id of nodeIds) unsubs.push(s.getState().subscribeNode(id, () => fired.nodes.add(id)));
  for (const e of edges) unsubs.push(s.getState().subscribeEdge(e.id, () => fired.edges.add(e.id)));
  unsubs.push(s.getState().subscribeNodesList(() => (fired.nodesList = true)));
  unsubs.push(s.getState().subscribeEdgesList(() => (fired.edgesList = true)));
  unsubs.push(s.getState().subscribeSelection(() => (fired.selection = true)));
  unsubs.push(s.getState().subscribeConnection(() => (fired.connection = true)));

  const teardown = () => {
    for (const u of unsubs) u();
    root.unmount();
  };
  return { s, fired, nodeIds, edges, teardown };
}

export async function verifyWakeCompletenessFull(): Promise<{ ok: boolean; checks: Record<string, unknown> }> {
  const violations: Violation[] = [];
  const spurious: Violation[] = [];

  // a single mutation step: snapshot everything, run it, assert completeness (+ optional tightness)
  const makeStep =
    (ctx: Awaited<ReturnType<typeof mount>>) =>
    (name: string, mutate: () => void, expect: Expect = {}) => {
      const { s, fired, nodeIds, edges } = ctx;
      fired.nodes.clear();
      fired.edges.clear();
      fired.nodesList = fired.edgesList = fired.selection = fired.connection = false;

      const beforeN = new Map(nodeIds.map((id) => [id, snapNode(s, id)] as const));
      const beforeE = new Map(edges.map((e) => [e.id, snapEdge(s, e)] as const));
      const beforeNL = nodeIdList(s);
      const beforeEL = edgeIdList(s);
      const beforeSel = selectionSig(s);
      const beforeConn = connectionSig(s);

      flushSync(mutate);

      // keyed: node
      for (const id of nodeIds) {
        const b = beforeN.get(id)!;
        const a = snapNode(s, id);
        if (!b.present || !a.present) continue;
        if (nodeChanged(b, a) && !fired.nodes.has(id)) violations.push({ step: name, kind: 'node', id, detail: 'changed but not woken (stale)' });
        if (!nodeChanged(b, a) && fired.nodes.has(id)) spurious.push({ step: name, kind: 'node', id, detail: 'woken without change' });
      }
      // keyed: edge
      for (const e of edges) {
        const b = beforeE.get(e.id)!;
        const a = snapEdge(s, e);
        if (!b.present || !a.present) continue;
        if (edgeChanged(b, a) && !fired.edges.has(e.id)) violations.push({ step: name, kind: 'edge', id: e.id, detail: 'changed but not woken (stale)' });
        if (!edgeChanged(b, a) && fired.edges.has(e.id)) spurious.push({ step: name, kind: 'edge', id: e.id, detail: 'woken without change' });
      }
      // coarse: completeness (value changed => fired) + spurious tracking
      const coarse: Array<[string, boolean, boolean]> = [
        ['nodesList', beforeNL !== nodeIdList(s), fired.nodesList],
        ['edgesList', beforeEL !== edgeIdList(s), fired.edgesList],
        ['selection', beforeSel !== selectionSig(s), fired.selection],
        ['connection', connChanged(beforeConn, connectionSig(s)), fired.connection],
      ];
      for (const [chan, changed, didFire] of coarse) {
        if (changed && !didFire) violations.push({ step: name, kind: chan, id: '-', detail: 'derived value changed but channel not fired (stale consumer)' });
        if (!changed && didFire) spurious.push({ step: name, kind: chan, id: '-', detail: 'fired without change' });
      }
      // tightness: a flagged `false` means this step is a hot path that must NOT wake the channel
      const expectMap: Record<string, boolean | undefined> = expect as Record<string, boolean | undefined>;
      const firedMap: Record<string, boolean> = { nodesList: fired.nodesList, edgesList: fired.edgesList, selection: fired.selection, connection: fired.connection };
      for (const chan of Object.keys(expectMap)) {
        if (expectMap[chan] === false && firedMap[chan]) {
          violations.push({ step: name, kind: chan, id: '-', detail: 'woke on a hot path that must stay quiet (perf regression)' });
        }
      }
    };

  const change = (s: RFStore, c: NodeChange) => s.getState().setNodes(applyNodeChanges([c], s.getState().nodes as Node[]) as Node[]);
  const echange = (s: RFStore, c: EdgeChange) => s.getState().setEdges(applyEdgeChanges([c], s.getState().edges as Edge[]) as Edge[]);

  // ===================== SCENE 1: flat graph (the incremental hot path) =====================
  {
    const nodes: Node[] = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map((id, i) => ({
      id,
      type: 'handle',
      position: { x: (i % 3) * 200, y: Math.floor(i / 3) * 200 },
      data: { label: id },
    }));
    const edges: Edge[] = [
      { id: 'e0', source: 'n0', target: 'n1' },
      { id: 'e2', source: 'n0', target: 'n1' }, // parallel to e0
      { id: 'e1', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n4', target: 'n5' },
    ];
    const ctx = await mount(nodes, edges);
    const step = makeStep(ctx);
    const s = ctx.s;

    // hot path: position-only drag on a flat graph wakes only n0 + its incident edges, nothing coarse
    step('drag n0', () => change(s, { id: 'n0', type: 'position', position: { x: 50, y: 60 } }), {
      nodesList: false, edgesList: false, selection: false, connection: false,
    });
    // data change still incremental (same id set) -> no list wake; incident edges re-path
    step('data n1', () => change(s, { id: 'n1', type: 'replace', item: { ...(s.getState().nodeLookup.get('n1') as Node), data: { label: 'n1*' } } }), {
      nodesList: false, selection: false,
    });
    // selection wakes the selection channel but not the list (incremental)
    step('select n2', () => change(s, { id: 'n2', type: 'select', selected: true }), { nodesList: false, selection: true });
    // connection gestures wake only the connection channel
    step('connection click-start', () => s.getState().setConnectionClickStartHandle({ nodeId: 'n0', id: null, type: 'source' } as never), {
      nodesList: false, edgesList: false, selection: false, connection: true,
    });
    step('cancel connection', () => s.getState().cancelConnection(), { connection: true });
    // edge object change (select) wakes the per-edge channel + selection, not the edge list
    step('select edge e0', () => echange(s, { id: 'e0', type: 'select', selected: true }), { edgesList: false, selection: true });
    // add / remove an edge wakes the edge list
    step('add edge e9', () => echange(s, { type: 'add', item: { id: 'e9', source: 'n1', target: 'n2' } }), { edgesList: true });
    step('remove edge e9', () => echange(s, { id: 'e9', type: 'remove' }), { edgesList: true });
    // add / remove a node wakes the node list, existing nodes keep their refs (no false wake)
    step('add node tmp', () => change(s, { type: 'add', item: { id: 'tmp', type: 'handle', position: { x: 9, y: 9 }, data: {} } }), { nodesList: true });
    step('remove node tmp', () => change(s, { id: 'tmp', type: 'remove' }), { nodesList: true });
    // patchNodes: keyed write, bypasses the array -> node + incident edges only, no list / selection
    const nodesRefBefore = s.getState().nodes;
    step('patch position n3', () => s.getState().patchNodes([{ id: 'n3', position: { x: 333, y: 333 } }]), { nodesList: false, selection: false });
    const patchBypassedArray = s.getState().nodes === nodesRefBefore;
    // reset wakes every coarse channel (the renderers + SelectionListener re-read the empty graph)
    step('reset', () => s.getState().reset(), { nodesList: true, edgesList: true, selection: true, connection: true });

    ctx.teardown();
    await raf();
    if (!patchBypassedArray) violations.push({ step: 'patch position n3', kind: 'array', id: '-', detail: 'patchNodes mutated the user nodes array (should bypass it)' });
  }

  // ===================== SCENE 2: parented graph (subflow cascade + patch cascade) =====================
  {
    const nodes: Node[] = [
      { id: 'P', type: 'handle', position: { x: 0, y: 0 }, data: { label: 'P' } },
      { id: 'c0', type: 'handle', parentId: 'P', position: { x: 10, y: 60 }, data: { label: 'c0' } },
      { id: 'c1', type: 'handle', parentId: 'P', position: { x: 10, y: 120 }, data: { label: 'c1' } },
      { id: 'x0', type: 'handle', position: { x: 400, y: 0 }, data: { label: 'x0' } },
    ];
    const edges: Edge[] = [{ id: 'eC', source: 'c0', target: 'x0' }];
    const ctx = await mount(nodes, edges);
    const step = makeStep(ctx);
    const s = ctx.s;

    // moving the parent cascades absolute position to c0/c1 (their internalNode swaps) and re-paths
    // c0's incident edge. (A parented graph takes the full-rebuild path, so the node-list may wake
    // conservatively; that is reported as spurious, not asserted here.)
    step('move parent P', () => change(s, { id: 'P', type: 'position', position: { x: 150, y: 150 } }));
    // patchNodes on the parent cascades through the keyed path, bypassing the array / list
    const arrRef = s.getState().nodes;
    step('patch parent P', () => s.getState().patchNodes([{ id: 'P', position: { x: 300, y: 300 } }]), { nodesList: false, selection: false });
    const patchBypassed = s.getState().nodes === arrRef;

    ctx.teardown();
    await raf();
    if (!patchBypassed) violations.push({ step: 'patch parent P', kind: 'array', id: '-', detail: 'patchNodes mutated the user nodes array' });
  }

  const ok = violations.length === 0;
  return {
    ok,
    checks: {
      missedOrTightnessViolations: violations.length,
      violations,
      spuriousWakes: spurious.length,
      spurious: spurious.slice(0, 30),
    },
  };
}

(window as unknown as { __wake: Record<string, unknown> }).__wake = {
  ...((window as unknown as { __wake?: Record<string, unknown> }).__wake ?? {}),
  verifyWakeCompletenessFull,
};
