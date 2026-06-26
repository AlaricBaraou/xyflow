/*
 * Wake-completeness verifier (test-only).
 *
 * Proves the per-entity channel's core invariant: after any mutation, every still-mounted
 * subscriber whose rendered value actually changed was woken. zustand's broadcast model is
 * correct by construction (everyone re-checks every emit); the keyed channel trades that for
 * O(changed) by having the writer declare which ids changed, so the one thing that can go wrong
 * is a MISSED WAKE (a subscriber that should have re-rendered but didn't -> silent stale UI).
 *
 * Ground truth = exactly what a subscriber reads, by reference, matching the channel's own
 * version-bump triggers (this is the immutable-swap invariant: any change swaps the object):
 *   - node : nodeLookup.get(id) ref + parentLookup.has(id)        (fully on-channel since #5828)
 *   - edge : source + target internalNode refs                    (endpoint re-path, #5828 scope)
 *
 * "Still-mounted" matters: a removed node's wrapper unmounts, and the channel deliberately does
 * NOT wake it (waking would deref a missing nodeLookup entry). So removed ids are excluded, not
 * counted as missed wakes. We assert: changed-and-still-present  ===>  was woken.
 *
 * Driven against the source-aliased build (vite aliases @xyflow/* to packages/.../src), same as
 * the other verifiers. Exposed as window.__wake.verifyWakeCompleteness, run by drive-wake.cjs.
 */
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { applyNodeChanges, type Edge, type Node, type NodeChange } from '@xyflow/react';
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

type Violation = { step: string; kind: 'node' | 'edge'; id: string; detail: string };

// --- ground-truth snapshots (by reference, matching the channel's bump triggers) ---
type NodeSnap = { present: boolean; ref: unknown; isParent: boolean };
type EdgeSnap = { present: boolean; srcRef: unknown; tgtRef: unknown };

function snapNode(s: RFStore, id: string): NodeSnap {
  const st = s.getState();
  const ref = st.nodeLookup.get(id);
  return { present: ref !== undefined, ref, isParent: st.parentLookup.has(id) };
}
const nodeChanged = (a: NodeSnap, b: NodeSnap) => a.ref !== b.ref || a.isParent !== b.isParent;

function snapEdge(s: RFStore, e: Edge): EdgeSnap {
  const st = s.getState();
  const present = st.edgeLookup.has(e.id);
  return { present, srcRef: st.nodeLookup.get(e.source), tgtRef: st.nodeLookup.get(e.target) };
}
const edgeChanged = (a: EdgeSnap, b: EdgeSnap) => a.srcRef !== b.srcRef || a.tgtRef !== b.tgtRef;

export async function verifyWakeCompleteness(): Promise<{ ok: boolean; checks: Record<string, unknown> }> {
  // graph: a subflow (P + children) to exercise the parent->child cascade, plus flat handle
  // nodes wired by edges, including a parallel pair (e0,e2 share endpoints) to prove the
  // incidentEdges map keys by bare nodeId and does not collapse parallel edges.
  const nodes: Node[] = [
    { id: 'P', type: 'bench', position: { x: 0, y: 0 }, data: { label: 'P' } },
    { id: 'c0', type: 'handle', parentId: 'P', position: { x: 10, y: 40 }, data: { label: 'c0' } },
    { id: 'c1', type: 'handle', parentId: 'P', position: { x: 10, y: 90 }, data: { label: 'c1' } },
    { id: 'n0', type: 'handle', position: { x: 400, y: 0 }, data: { label: 'n0' } },
    { id: 'n1', type: 'handle', position: { x: 600, y: 0 }, data: { label: 'n1' } },
    { id: 'n2', type: 'handle', position: { x: 400, y: 200 }, data: { label: 'n2' } },
    { id: 'n3', type: 'handle', position: { x: 600, y: 200 }, data: { label: 'n3' } },
    { id: 'n4', type: 'handle', position: { x: 400, y: 400 }, data: { label: 'n4' } },
  ];
  const edges: Edge[] = [
    { id: 'e0', source: 'n0', target: 'n1' },
    { id: 'e2', source: 'n0', target: 'n1' }, // parallel to e0
    { id: 'e1', source: 'n2', target: 'n3' },
    { id: 'e3', source: 'c0', target: 'n4' }, // incident to a cascaded child
  ];

  let store: RFStore | null = null;
  const root = createRoot(sceneEl());
  root.render(createElement(Flow, { nodes, edges, onReady: (s: RFStore) => (store = s) }));
  await waitNodes(nodes.length);
  for (let i = 0; i < 200 && !store; i++) await raf();
  if (!store) throw new Error('store not captured');
  const s = store as RFStore;

  // subscribe a probe to every node and edge id through the public channel API. The set of
  // probes that fire during a mutation IS the channel's woken set.
  const firedNodes = new Set<string>();
  const firedEdges = new Set<string>();
  const unsubs: Array<() => void> = [];
  const nodeIds = nodes.map((n) => n.id);
  for (const id of nodeIds) unsubs.push(s.getState().subscribeNode(id, () => firedNodes.add(id)));
  for (const e of edges) unsubs.push(s.getState().subscribeEdge(e.id, () => firedEdges.add(e.id)));

  const violations: Violation[] = [];
  const spurious: Violation[] = [];

  // one mutation step: snapshot all tracked ids, run the change, then assert every
  // changed-and-still-present subscriber was woken.
  const step = (name: string, mutate: () => void) => {
    firedNodes.clear();
    firedEdges.clear();
    const beforeN = new Map(nodeIds.map((id) => [id, snapNode(s, id)] as const));
    const beforeE = new Map(edges.map((e) => [e.id, snapEdge(s, e)] as const));

    flushSync(mutate);

    for (const id of nodeIds) {
      const before = beforeN.get(id)!;
      const after = snapNode(s, id);
      if (!before.present || !after.present) continue; // added/removed -> handled by (un)mount, not the channel
      const changed = nodeChanged(before, after);
      if (changed && !firedNodes.has(id)) {
        violations.push({ step: name, kind: 'node', id, detail: 'changed but not woken (stale render)' });
      }
      if (!changed && firedNodes.has(id)) {
        spurious.push({ step: name, kind: 'node', id, detail: 'woken without change (wasted)' });
      }
    }
    for (const e of edges) {
      const before = beforeE.get(e.id)!;
      const after = snapEdge(s, e);
      if (!before.present || !after.present) continue;
      const changed = edgeChanged(before, after);
      if (changed && !firedEdges.has(e.id)) {
        violations.push({ step: name, kind: 'edge', id: e.id, detail: 'endpoint moved but edge not re-pathed (stale)' });
      }
      if (!changed && firedEdges.has(e.id)) {
        spurious.push({ step: name, kind: 'edge', id: e.id, detail: 'woken without endpoint change (wasted)' });
      }
    }
  };

  const change = (c: NodeChange) => s.getState().setNodes(applyNodeChanges([c], s.getState().nodes as Node[]) as Node[]);

  // --- the battery: every shipped path that mutates a node the channel owns ---

  // 1. position drag (incremental adopt fast path): only n0 + its incident edges (e0,e2) wake
  step('drag n0', () => change({ id: 'n0', type: 'position', position: { x: 450, y: 50 } }));

  // 2. data change: n1's internalNode ref swaps; incident edges (e0,e2 target n1) re-path
  step('data n1', () =>
    change({ id: 'n1', type: 'replace', item: { ...(s.getState().nodeLookup.get('n1') as Node), data: { label: 'n1*' } } })
  );

  // 3. selection: n2 ref swaps; its incident edge (e1) re-paths
  step('select n2', () => change({ id: 'n2', type: 'select', selected: true }));

  // 4. parent move: cascade to c0,c1 (their absolute position swaps the internalNode);
  //    c0's incident edge (e3) re-paths. This is the subflow cascade where stale bugs hide.
  step('move parent P', () => change({ id: 'P', type: 'position', position: { x: 120, y: 120 } }));

  // 5. add an unrelated node: full-rebuild path, but existing nodes keep their userNode ref so
  //    none of them should wake (and the new id is not subscribed).
  step('add tmp', () => change({ type: 'add', item: { id: 'tmp', type: 'bench', position: { x: 9, y: 9 }, data: {} } }));

  // 6. remove it again: removed id is excluded; no surviving node should falsely wake.
  step('remove tmp', () => change({ id: 'tmp', type: 'remove' }));

  for (const u of unsubs) u();
  root.unmount();
  await raf();

  const ok = violations.length === 0;
  return {
    ok,
    checks: {
      steps: 6,
      missedWakes: violations.length,
      violations,
      spuriousWakes: spurious.length,
      spurious: spurious.slice(0, 20),
    },
  };
}

(window as unknown as { __wake: Record<string, unknown> }).__wake = {
  ...((window as unknown as { __wake?: Record<string, unknown> }).__wake ?? {}),
  verifyWakeCompleteness,
};
