#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getGraph, rescan } from './cache.js';
import { getComponentDetail, hasSvelteFile, toNodeId, type GraphData, type GraphNode } from './parser.js';

const NAME = 'svelte-component-graph-mcp';
const VERSION = '0.1.0';

// --- result helpers ------------------------------------------------------------------------------

function ok(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * Validate the `root` parameter shared by every tool: must be an absolute path to an existing
 * directory that contains at least one `.svelte` file. Returns an error message, or null when valid.
 */
function validateRoot(root: string): string | null {
    if (!path.isAbsolute(root)) {
        return `Error: root must be an absolute path. Got: ${root}`;
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(root);
    } catch {
        return `Error: root does not exist on disk: ${root}`;
    }
    if (!stat.isDirectory()) {
        return `Error: root is not a directory: ${root}`;
    }
    if (!hasSvelteFile(root)) {
        return `Error: no .svelte files found under root: ${root}`;
    }
    return null;
}

/** Normalize a (possibly absolute) workspace-relative path param into a canonical node id. */
function toComponentId(root: string, p: string): string {
    // Reuse the canonical id producer for the absolute case so there is one source of truth for the
    // id format; for a relative path just normalize separators and strip a leading "./".
    return path.isAbsolute(p)
        ? toNodeId(p, root)
        : p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Build source→children and target→parents adjacency once, for O(1) neighbour lookups. */
function adjacency(graph: GraphData): { parents: Map<string, string[]>; children: Map<string, string[]> } {
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    for (const { source, target } of graph.links) {
        (children.get(source) ?? children.set(source, []).get(source)!).push(target);
        (parents.get(target) ?? parents.set(target, []).get(target)!).push(source);
    }
    return { parents, children };
}

// --- server --------------------------------------------------------------------------------------

const server = new McpServer({ name: NAME, version: VERSION });

const rootSchema = {
    root: z.string().describe('Absolute path to the SvelteKit/Svelte project root to analyze.')
};

server.registerTool(
    'get_graph',
    {
        title: 'Get component graph',
        description:
            'Return the full Svelte component dependency graph for a project: every component/route node ' +
            '(workspace-relative path id + display label + type + unused flag) and every import link.',
        inputSchema: rootSchema
    },
    async ({ root }) => {
        const error = validateRoot(root);
        if (error) return fail(error);
        return ok(getGraph(root));
    }
);

server.registerTool(
    'get_component',
    {
        title: 'Get one component',
        description:
            'Look up a single component or route by its workspace-relative path (e.g. ' +
            '"src/lib/Button.svelte"). Returns its parents (components that import it), children ' +
            '(components it imports), whether it is unused/a route, and its Svelte 5 public API ' +
            'surface: props (name, optional, bindable, rest) and slots.',
        inputSchema: {
            ...rootSchema,
            path: z
                .string()
                .describe('Workspace-relative path to the component, e.g. "src/lib/Button.svelte".')
        }
    },
    async ({ root, path: componentPath }) => {
        const error = validateRoot(root);
        if (error) return fail(error);

        const graph = getGraph(root);
        const id = toComponentId(root, componentPath);
        const node = graph.nodes.find((n: GraphNode) => n.id === id);
        if (!node) {
            return fail(
                `Error: no component with path "${id}" was found in the graph for ${root}. ` +
                    `Pass a workspace-relative path such as "src/lib/Button.svelte".`
            );
        }
        const { parents, children } = adjacency(graph);
        const detail = getComponentDetail(path.join(root, ...id.split('/')), root);
        return ok({
            id: node.id,
            label: node.label,
            type: node.type,
            unused: node.unused === true,
            isRoute: node.type === 'route',
            parents: parents.get(id) ?? [],
            children: children.get(id) ?? [],
            props: detail.props,
            slots: detail.slots
        });
    }
);

server.registerTool(
    'get_unused',
    {
        title: 'Get unused components',
        description:
            'Return every component that is imported somewhere in the project but rendered nowhere ' +
            "(never referenced in any importer's template). Computed globally, so the result does not " +
            'depend on file order.',
        inputSchema: rootSchema
    },
    async ({ root }) => {
        const error = validateRoot(root);
        if (error) return fail(error);
        const graph = getGraph(root);
        return ok(graph.nodes.filter((n: GraphNode) => n.unused === true));
    }
);

server.registerTool(
    'get_routes',
    {
        title: 'Get routes',
        description:
            'Return every route node (+page/+layout/+error) with its display label and the direct ' +
            'child components it pulls in.',
        inputSchema: rootSchema
    },
    async ({ root }) => {
        const error = validateRoot(root);
        if (error) return fail(error);
        const graph = getGraph(root);
        const { children } = adjacency(graph);
        const routes = graph.nodes
            .filter((n: GraphNode) => n.type === 'route')
            .map((n: GraphNode) => ({
                id: n.id,
                label: n.label,
                children: children.get(n.id) ?? []
            }));
        return ok(routes);
    }
);

server.registerTool(
    'scan',
    {
        title: 'Force rescan',
        description:
            'Invalidate all caches for the project and re-parse every file from scratch. Returns a ' +
            'summary with the node and link counts. Use when you want to guarantee fresh results.',
        inputSchema: rootSchema
    },
    async ({ root }) => {
        const error = validateRoot(root);
        if (error) return fail(error);
        const graph = rescan(root);
        return ok({ nodes: graph.nodes.length, links: graph.links.length });
    }
);

// --- transport -----------------------------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stdout is reserved for the JSON-RPC protocol — all logging must go to stderr.
    console.error(`[${NAME}] ready on stdio`);
}

main().catch(err => {
    console.error(`[${NAME}] fatal:`, err);
    process.exit(1);
});
