# svelte-component-graph-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes a Svelte/SvelteKit project's
**component dependency graph** over stdio, so an AI coding assistant can ask questions like
_"what imports `Button.svelte`?"_, _"which components are unused?"_, or _"what does this route pull
in?"_ without opening an editor.

It is the command-line companion to the
[Svelte Component Visualizer](https://marketplace.visualstudio.com/items?itemName=jamcgrath.svelte-component-visualizer)
VS Code extension and uses the same analysis: the Svelte compiler's AST + `estree-walker` to track
default **and** named `.svelte` imports, resolve static `<svelte:component this={Identifier}>` usage,
and flag imported-but-unused components.

## What it gives you

A graph of every component and route in the project:

- **Nodes** are keyed by **workspace-relative path** (`src/lib/Button.svelte`) — so two files that
  share a name are never conflated — with a human-readable `label`, a `type` (`component` | `route`),
  and an `unused` flag.
- **Links** are import edges (`source` imports `target`).

The server is **stateless across projects**: every tool takes a `root` argument, so one running
server can answer questions about many projects (and many git worktrees) at once. Results are cached
per root and refreshed automatically when files change (checked on each call by mtime + size; only
changed files are re-parsed).

## Installation

This is a **stdio MCP server** — your MCP client launches it; you don't run it by hand. Requires
**Node.js ≥ 20**. Pick the path that matches your setup.

### Claude Code — plugin (recommended)

Installs the MCP server **and** the companion `/svelte-graph` skill in one step:

```
/plugin marketplace add jamcgrath/svelte-component-graph-mcp
/plugin install svelte-component-graph@jamcgrath
```

Restart Claude Code afterward so the server connects. Nothing to clone or build — it runs via `npx`.
(The two commands can be combined: `/plugin install svelte-component-graph@jamcgrath/svelte-component-graph-mcp`.)

### Claude Code — server only (no skill)

```bash
claude mcp add svelte-graph --scope user -- npx -y svelte-component-graph-mcp
```

### Other MCP clients (Claude Desktop, Cursor, Cline, …)

Add it to the client's MCP config:

```json
{
  "mcpServers": {
    "svelte-graph": {
      "command": "npx",
      "args": ["-y", "svelte-component-graph-mcp"]
    }
  }
}
```

(If you `npm install -g svelte-component-graph-mcp`, use `"command": "svelte-component-graph-mcp"` with
`"args": []`.)

### Quick test, no client

Drive it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npx -y svelte-component-graph-mcp
```

## The `root` argument

Every tool requires `root`: an **absolute path** to the project you want analyzed. The server
validates that it exists, is a directory, and contains at least one `.svelte` file.

Guidance for the assistant when choosing `root`:

- If a `svelte.config.js` exists in the current working directory, the project root **is** the cwd —
  pass `$PWD`.
- Otherwise (e.g. a monorepo, or the cwd is a subfolder), pass the project's absolute path explicitly.

## Companion skill

A Claude Code skill ([`skills/svelte-graph/`](skills/svelte-graph/SKILL.md)) teaches the assistant
*when* to reach for these tools (impact analysis, dead-code hunts, prop lookups) and how to resolve
`root`. The MCP tools work without it; the skill just makes the assistant use them more readily.

**If you installed the plugin, you already have it** — nothing to do. Otherwise, copy the folder into a
skills directory:

```bash
# user-level (all your projects)
cp -r skills/svelte-graph ~/.claude/skills/svelte-graph
# or project-level (this repo only)
cp -r skills/svelte-graph .claude/skills/svelte-graph
```

Then invoke it with `/svelte-graph`, or let the assistant trigger it automatically.

## Tools

### `get_graph(root)`
The full graph.

```jsonc
{
  "nodes": [
    { "id": "src/routes/+page.svelte", "label": "(page) /", "type": "route" },
    { "id": "src/lib/Button.svelte", "label": "Button", "type": "component" },
    { "id": "src/lib/Unused.svelte", "label": "Unused", "type": "component", "unused": true }
  ],
  "links": [
    { "source": "src/routes/+page.svelte", "target": "src/lib/Button.svelte" }
  ]
}
```

### `get_component(root, path)`
Details for one component/route, including its public API surface. `path` is workspace-relative
(`src/lib/Button.svelte`).

```jsonc
{
  "id": "src/lib/Widget.svelte",
  "label": "Widget",
  "type": "component",
  "unused": false,
  "isRoute": false,
  "parents": ["src/routes/+page.svelte"],   // components that import it
  "children": [],                            // components it imports
  "props": [                                  // from $props()
    { "name": "size",  "optional": true,  "bindable": false },
    { "name": "open",  "optional": true,  "bindable": true },
    { "name": "title", "optional": false, "bindable": false },
    { "name": "rest",  "optional": true,  "bindable": false, "rest": true }
  ],
  "slots": ["default", "footer"]             // <slot> / <slot name="…">
}
```

Props come from Svelte 5 runes (`$props()`, `$bindable()`, `...rest`). Events are not a separate
concept in Svelte 5 — they are ordinary callback props, so they appear in `props`.

### `get_unused(root)`
Every component imported somewhere but never used in the importing file's template.

```jsonc
[
  { "id": "src/lib/Unused.svelte", "label": "Unused", "type": "component", "unused": true }
]
```

### `get_routes(root)`
Every route (`+page` / `+layout` / `+error`) with the components it directly pulls in.

```jsonc
[
  {
    "id": "src/routes/dashboard/+page.svelte",
    "label": "(page) /dashboard",
    "children": ["src/lib/Icon.svelte", "src/lib/components/Button.svelte"]
  }
]
```

### `scan(root)`
Force a full re-parse (bypassing all caches) and return the resulting size.

```jsonc
{ "nodes": 7, "links": 5 }
```

## How resolution works (and its limits)

- Relative imports (`./`, `../`) resolve against the importing file's directory.
- SvelteKit's `$lib/…` resolves to the nearest `src/lib` (monorepo-aware — it uses the importing
  file's own `src/`, not a global root).
- Other bare/aliased specifiers (custom Vite aliases beyond `$lib`) are kept as best-effort leaf
  nodes rather than resolved to a file. As a corollary, a bare package import like
  `import X from 'some-pkg/Foo.svelte'` is keyed by that raw path and would merge with a local file
  at the same relative path (`some-pkg/Foo.svelte`) if one exists — an unlikely but possible collision.
- `<svelte:component this={…}>` is resolved only when `this` is a plain imported identifier; dynamic
  expressions (member access, conditionals) are not traced.
- `componentPaths` / `routePaths` accept negation globs (`!**/*.stories.svelte`) to exclude files: a
  file is included when it matches a positive pattern and no negation pattern.
- `props` are read from the `$props()` object destructuring. A non-destructured binding
  (`let props = $props()`) has no statically-known prop names, so `props` comes back empty for it.

## License

MIT © James McGrath
