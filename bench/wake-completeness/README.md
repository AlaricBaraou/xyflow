# Wake-completeness verifier

A test-only harness that proves the per-entity subscription channels never leave a subscriber stale.

## Why this exists

The perf work moves per-entity components off the global zustand `useStore` fan-out (every selector
re-runs on every `set()`) and onto fine-grained channels read through `useSyncExternalStore`. zustand's
broadcast model is **correct by construction**: every subscriber re-checks on every emit, so nothing can
go stale. The keyed channels trade that for O(changed) by having the writer declare which ids changed and
waking only those. The one thing that can go wrong is a **missed wake**: a subscriber whose rendered value
changed but whose channel was not notified, i.e. silent stale UI.

This harness re-introduces the broadcast check as an assertion. It subscribes a probe to every id through
the public channel API (`subscribeNode` / `subscribeEdge` and the coarse `subscribeNodesList` /
`subscribeEdgesList` / `subscribeSelection` / `subscribeConnection`), so the set of probes that fire **is**
the channel's woken set. Ground truth is what a subscriber actually reads, by reference (matching each
channel's bump trigger, i.e. the immutable-swap invariant):

| channel | ground truth (changed when this changes) |
| --- | --- |
| per-node | `internalNode` ref + `parentLookup.has(id)` |
| per-edge | edge object ref + both endpoint `internalNode` refs |
| node-list / edge-list | the id-key order |
| selection | the selected node / edge id sets |
| connection | the `connection` state + click-start handle refs |

Removed ids are excluded: their wrapper unmounts and the channel deliberately does not wake them.

## What it asserts

Per mutation, two properties:

- **Completeness (correctness):** if a subscriber's ground-truth value changed, its channel fired. A miss
  is a stale-UI bug.
- **Tightness (the perf claim):** a flat position-only drag must NOT wake the coarse channels (node-list /
  edge-list / selection / connection). If it did, the renderers and `SelectionListener` would recompute
  every frame and the optimization would be moot. Asserted only where the cheap path is guaranteed (flat
  graph, position-only); conservative full-rebuild wakes elsewhere are reported as spurious, not failures.

Two verifiers (`window.__wake`):

- `verifyWakeCompleteness` (`src/wake-bench.ts`) — node + edge endpoint re-path. Six mutation steps.
- `verifyWakeCompletenessFull` (`src/wake-bench-full.ts`) — every channel: node, edge object, node-list,
  edge-list, selection, connection, plus `patchNodes` (and that it bypasses the user nodes array) and
  `reset` (wakes all four coarse channels). A flat scene (the incremental hot path) and a parented scene
  (subflow cascade + patch cascade).

## Run it

The harness is source-aliased: `vite.config.ts` points `@xyflow/react` and `@xyflow/system` at
`packages/*/src`, so it runs against the live store source with no build.

```bash
pnpm install            # or npm install
pnpm dev                # starts vite on :4320 (source-aliased)
# in another shell:
pnpm verify             # headless chromium runs every window.__wake.verify*
```

`pnpm verify` exits non-zero if any verifier fails.

## Result on this branch

Both verifiers are green. The only flags are spurious (wasted, never stale) wakes on node-add, a benign
artifact of the probe not subscribing the freshly-added id (it trips the conservative culling re-path).

```
=== verifyWakeCompleteness: OK ===      { "missedWakes": 0, "violations": [] }
=== verifyWakeCompletenessFull: OK ===  { "missedOrTightnessViolations": 0, "violations": [] }
ALL WAKE VERIFIERS OK
```

## It has teeth (negative controls)

A green run that cannot fail is worthless. Two deliberate breaks in the store, each caught:

1. Disable the edge re-path (`notifyIncidentEdges` in the changed-ids path) -> **6 missed wakes**:
   ```
   verifyWakeCompleteness: FAIL
   drag n0  edge e0  endpoint moved but edge not re-pathed (stale)
   drag n0  edge e2  endpoint moved but edge not re-pathed (stale)
   data n1  edge e0  ...   data n1  edge e2  ...
   select n2  edge e1  ...   move parent P  edge e3  ...
   ```
2. Disable `selection.notify()` in `setNodes` -> the selection miss caught:
   ```
   verifyWakeCompletenessFull: FAIL
   select n2  selection  derived value changed but channel not fired (stale consumer)
   ```

## Note: the contract is branch-scoped

What a channel owes grows as each PR moves more onto it. On the foundation only the node is fully
on-channel and edges wake on endpoint moves only; the edge object joins the channel later, then the coarse
list/selection channels, then connection and `patchNodes`. The two verifiers reflect that: the foundation
one checks node + edge endpoint, the full one checks every channel. This branch has all of them, so the
full verifier runs.

This harness is the safety net for the channel approach: it stays green through the `createKeyedChannel`
extraction in this branch, which is how the refactor is shown to be behaviour-preserving rather than just
asserted to be.
