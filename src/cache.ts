import {
    assembleGraph,
    invalidateParseCache,
    scanProject,
    type GraphData,
    type ParserOptions
} from './parser.js';

/**
 * Graph-level cache, keyed by absolute root path. Sits *on top* of the parser's per-file mtime+size
 * cache: each call does ONE filesystem scan (walk + stat of the included files), compares the
 * resulting stamps to what was cached, and returns the stored graph untouched when nothing changed.
 * On a change it reassembles — and the parser's own cache re-parses only the files that actually moved.
 *
 * The stamp map is keyed by each file's workspace-relative id and stores a "<mtimeMs>:<size>" stamp,
 * so staleness detection catches added, removed, and modified files alike.
 */
interface CacheEntry {
    graph: GraphData;
    stamps: Map<string, string>;
}

const cache = new Map<string, CacheEntry>();

// Bound the number of cached roots so a long-lived server queried against many projects/worktrees
// can't grow unbounded. Map keeps insertion order; we re-insert on access for LRU eviction.
const MAX_CACHED_ROOTS = 32;

function stampsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const [id, s] of a) {
        if (b.get(id) !== s) {
            return false;
        }
    }
    return true;
}

/**
 * Freeze a graph before caching so a value handed to a tool can't be mutated in place (sort/splice/
 * push on nodes or links) and silently poison every later cache hit.
 */
function freezeGraph(graph: GraphData): GraphData {
    Object.freeze(graph.nodes);
    Object.freeze(graph.links);
    return Object.freeze(graph);
}

/** Insert (or refresh) a root at the most-recently-used position, evicting the oldest over the cap. */
function store(root: string, entry: CacheEntry): void {
    cache.delete(root);
    cache.set(root, entry);
    if (cache.size > MAX_CACHED_ROOTS) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
            cache.delete(oldest);
        }
    }
}

export function get(root: string): GraphData | undefined {
    return cache.get(root)?.graph;
}

export function invalidate(root: string): void {
    cache.delete(root);
}

/**
 * True when the cached graph for `root` no longer reflects the filesystem: no entry, a file added or
 * removed, or any included file's mtime/size changed since it was cached.
 */
export function isStale(root: string, options: ParserOptions = {}): boolean {
    const entry = cache.get(root);
    if (!entry) {
        return true;
    }
    return !stampsEqual(entry.stamps, scanProject(root, options).stamps);
}

/**
 * Return the graph for `root`, served from cache when nothing changed. One filesystem scan per call;
 * on a change, reassemble (the parser re-parses only the files whose stamp moved) and re-cache.
 */
export function getGraph(root: string, options: ParserOptions = {}): GraphData {
    const scan = scanProject(root, options);
    const entry = cache.get(root);
    if (entry && stampsEqual(entry.stamps, scan.stamps)) {
        store(root, entry); // LRU touch
        return entry.graph;
    }
    const graph = freezeGraph(assembleGraph(root, options, scan));
    store(root, { graph, stamps: scan.stamps });
    return graph;
}

/**
 * Force a full re-parse of `root`: drop every per-file parse entry for the scanned files so nothing
 * is served from the parser cache, then reassemble from scratch and re-cache.
 */
export function rescan(root: string, options: ParserOptions = {}): GraphData {
    const scan = scanProject(root, options);
    for (const entry of scan.entries) {
        invalidateParseCache(entry.file);
    }
    const graph = freezeGraph(assembleGraph(root, options, scan));
    store(root, { graph, stamps: scan.stamps });
    return graph;
}
