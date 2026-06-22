---
'@xyflow/react': patch
---

Take `Handle` off the global store fan-out. Each handle read its static config and the connection state through `useStore` selectors that re-ran on every store emit, so a node-position write fanned out to roughly two selector runs per handle. Config now comes from a context (one subscription for all handles) and connection state from a dedicated channel that only changes during connect gestures, so a node drag no longer wakes any handle. No behavior change; the gain is biggest on graphs with many handles.
