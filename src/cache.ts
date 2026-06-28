import * as fs from 'fs';
import {
    generateComponentGraph,
    invalidateParseCache,
    toNodeId,
    walkSvelteFiles,
    type GraphData,
    type ParserOptions
} from './parser.js';

/**
 * Graph-level cache, keyed by absolute root path. Sits *on top* of the parser's per-file mtime+size
 * cache: when nothing under a root has changed, we return the stored graph without even reassembling
 * it. When something has changed, the parser's own cache ensures only the changed files re-parse.
 *
 * The mtime map is keyed by each file's workspace-relative id and stores a "<mtimeMs>:<size>" stamp,
 * so staleness detection catches added, removed, and modified files alike.
 */
interface CacheEntry {
    graph: GraphData;
    mtimes: Map<string, string>;
}

const cache = new Map<string, CacheEntry>();

function stamp(stat: fs.Stats): string {
    return `${stat.mtimeMs}:${stat.size}`;
}

/** Build the current id → "<mtimeMs>:<size>" map for every `.svelte` file under `root`. */
function currentMtimes(root: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const file of walkSvelteFiles(root)) {
        try {
            map.set(toNodeId(file, root), stamp(fs.statSync(file)));
        } catch {
            // File vanished between walk and stat — treat as absent (omit from the map).
        }
    }
    return map;
}

export function get(root: string): GraphData | undefined {
    return cache.get(root)?.graph;
}

export function set(root: string, graph: GraphData, mtimes: Map<string, string>): void {
    cache.set(root, { graph, mtimes });
}

export function invalidate(root: string): void {
    cache.delete(root);
}

/**
 * True when the cached graph for `root` no longer reflects the filesystem: no entry, a file added or
 * removed, or any file's mtime/size changed since it was cached.
 */
export function isStale(root: string): boolean {
    const entry = cache.get(root);
    if (!entry) {
        return true;
    }
    const current = currentMtimes(root);
    if (current.size !== entry.mtimes.size) {
        return true; // file added or removed
    }
    for (const [id, currentStamp] of current) {
        if (entry.mtimes.get(id) !== currentStamp) {
            return true; // modified, or a same-count add+remove swap
        }
    }
    return false;
}

/**
 * Return the graph for `root`, served from cache when nothing has changed. On a miss or when stale,
 * regenerate (the parser re-parses only the files whose mtime/size moved) and re-cache.
 */
export function getGraph(root: string, options: ParserOptions = {}): GraphData {
    if (!isStale(root)) {
        return cache.get(root)!.graph;
    }
    const graph = generateComponentGraph(root, options);
    set(root, graph, currentMtimes(root));
    return graph;
}

/**
 * Force a full re-parse of `root`: drop the cached graph AND every per-file parse entry under it, so
 * nothing is served from either cache layer, then regenerate from scratch and re-cache.
 */
export function rescan(root: string, options: ParserOptions = {}): GraphData {
    invalidate(root);
    for (const file of walkSvelteFiles(root)) {
        invalidateParseCache(file);
    }
    const graph = generateComponentGraph(root, options);
    set(root, graph, currentMtimes(root));
    return graph;
}
