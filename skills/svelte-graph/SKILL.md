---
name: svelte-graph
description: >-
  Explore a Svelte/SvelteKit project's component dependency graph via the
  svelte-component-visualizer MCP — what imports what, which components are
  unused, route→component maps, and a component's Svelte 5 props/slots. Use
  when asked to map components, do impact analysis before a refactor, find dead
  components, or look up how a component is used or what props it takes —
  instead of hand-grepping imports.
---

# Svelte component graph

This skill drives the **svelte-component-graph-mcp** server, which parses a
Svelte/SvelteKit project into a component dependency graph. Prefer these tools
over manually grepping `import` statements — the parser already resolves
relative + `$lib` imports, `<svelte:component this={Ident}>`, and unused
imports, and it caches per file.

## Prerequisite

The `svelte-component-graph-mcp` server must be configured in MCP settings.
If its tools aren't available, tell the user to add it (see the package README)
rather than falling back to grep.

## Resolving `root`

Every tool needs `root` — an **absolute path** to the project being analyzed:

- If `svelte.config.js` exists in the current working directory, `root` is the
  cwd (`$PWD`).
- Otherwise (monorepo, or cwd is a subfolder), use the project's absolute path.
  If unsure which package, ask.

`root` must be absolute, exist, and contain at least one `.svelte` file — the
tools return an error otherwise.

## The tools

| Tool | Use it to… |
|------|-----------|
| `get_graph(root)` | Get the whole map: every node (`id`, `label`, `type`, `unused?`) + every import link. Start here for "map the app" / broad impact analysis. |
| `get_component(root, path)` | Drill into one file. Returns `parents` (who imports it), `children` (what it imports), `unused`, `isRoute`, and its Svelte 5 `props` (name/optional/bindable/rest) + `slots`. `path` is **workspace-relative** (`src/lib/Button.svelte`). |
| `get_unused(root)` | List imported-but-never-rendered components (dead-code candidates). |
| `get_routes(root)` | Every `+page`/`+layout`/`+error` route with the components it directly pulls in. |
| `scan(root)` | Force a full re-parse (bypass caches) and return node/link counts. Use after large external changes (branch switch, generated files) when you want guaranteed-fresh results. |

Node **ids** are workspace-relative POSIX paths and are the source of truth for
lookups/links. **Labels** are display names (`Button`, `(page) /dashboard`).

## Recipes

- **Impact analysis before changing a component** → `get_component(root, path)`,
  read `parents` to see every caller you might break. For a wider blast radius,
  `get_graph` and trace links.
- **"What does this component need?"** → `get_component`, read `props` (note
  `optional` / `bindable` / `rest`) and `slots`.
- **Find dead code** → `get_unused(root)`. Confirm before deleting (a component
  could be used dynamically in ways the static parser can't see).
- **Understand a route** → `get_routes(root)`, or `get_component` on the
  `+page.svelte` for its `data` prop + children.
- **Stale results after a big change** → `scan(root)`, then re-query.

## Limits worth stating to the user

- Resolves relative + `$lib` imports; other custom Vite aliases become
  best-effort leaf nodes.
- `<svelte:component this={…}>` is traced only when `this` is a plain imported
  identifier.
- Svelte 5 only: props come from `$props()`; legacy `export let` /
  `createEventDispatcher` are not parsed. Events in Svelte 5 are callback props,
  so they appear under `props`.
