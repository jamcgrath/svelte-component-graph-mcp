#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getGraph, rescan } from './cache.js';
import { walkSvelteFiles, type GraphData, type GraphNode } from './parser.js';

const NAME = 'svelte-component-visualizer-mcp';
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
    if (walkSvelteFiles(root).length === 0) {
        return `Error: no .svelte files found under root: ${root}`;
    }
    return null;
}

/** Normalize a (possibly absolute) workspace-relative path param into a canonical node id. */
function toComponentId(root: string, p: string): string {
    const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
    return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

const parentsOf = (graph: GraphData, id: string): string[] =>
    graph.links.filter(l => l.target === id).map(l => l.source);

const childrenOf = (graph: GraphData, id: string): string[] =>
    graph.links.filter(l => l.source === id).map(l => l.target);

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
            '(components it imports), whether it is unused, and whether it is a route.',
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
        return ok({
            id: node.id,
            label: node.label,
            type: node.type,
            unused: node.unused === true,
            isRoute: node.type === 'route',
            parents: parentsOf(graph, id),
            children: childrenOf(graph, id)
        });
    }
);

server.registerTool(
    'get_unused',
    {
        title: 'Get unused components',
        description:
            'Return every component that is imported somewhere but never referenced in the importing ' +
            "file's template (the graph's `unused` nodes).",
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
        const routes = graph.nodes
            .filter((n: GraphNode) => n.type === 'route')
            .map((n: GraphNode) => ({
                id: n.id,
                label: n.label,
                children: childrenOf(graph, n.id)
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
