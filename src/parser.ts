import * as fs from 'fs';
import * as path from 'path';
import { Minimatch } from 'minimatch';
import * as svelte from 'svelte/compiler';
import { walk } from 'estree-walker';

/**
 * One graph node. `id` is a workspace-relative POSIX path (keeps `.svelte`); `label` is the
 * human-readable display name (basename for components, derived route string for routes).
 */
export interface GraphNode {
    id: string;
    label: string;
    type: 'component' | 'route';
    unused?: boolean;
}

export interface GraphLink {
    source: string;
    target: string;
}

export interface GraphData {
    nodes: GraphNode[];
    links: GraphLink[];
}

/**
 * Parser configuration. Mirrors the `svelteVisualizer.*` settings of the VS Code extension, but as a
 * plain options object (this package has no editor). Every field is optional; defaults match the
 * extension.
 */
export interface ParserOptions {
    /** Glob patterns (workspace-relative) for component files to include. Default `['**​/*.svelte']`. */
    componentPaths?: string[];
    /** Glob patterns for route files to include. Default `['**​/routes/**​/*.svelte']`. */
    routePaths?: string[];
    /** Directory name that marks routes, used for route detection/labels. Default `'routes'`. */
    routesBasePath?: string;
    /**
     * Glob patterns (matched against each file's workspace-relative id). Matching files treat ALL of
     * their `.svelte` imports as dependencies, regardless of template usage — useful for dynamic
     * renderer components that resolve children at runtime. Default `[]`.
     */
    unconditionalDependencyPaths?: string[];
}

const DEFAULT_COMPONENT_PATHS = ['**/*.svelte'];
const DEFAULT_ROUTE_PATHS = ['**/routes/**/*.svelte'];
const DEFAULT_ROUTES_BASE_PATH = 'routes';

// Directories never worth scanning. Kept as a Set for O(1) membership in the walk.
const IGNORED_DIRS = new Set(['node_modules', '.svelte-kit', 'build', 'dist']);

/**
 * Canonical node id: workspace-relative, POSIX-separated path (keeps the `.svelte` extension).
 * This is the single source of truth so a scanned file and an import that points at it always
 * produce the identical id string — otherwise links orphan into phantom duplicate nodes.
 */
export function toNodeId(absPath: string, workspaceRoot: string): string {
    return path.relative(workspaceRoot, absPath).split(path.sep).join('/');
}

/**
 * Resolve an import specifier (as written in source) to the same canonical id its target file
 * would get when scanned. Handles relative specifiers and SvelteKit's `$lib` alias; anything
 * else falls back to a best-effort id (a leaf node with no outgoing edges).
 */
function resolveImportId(specifier: string, importingFileAbs: string, workspaceRoot: string): string {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return toNodeId(path.resolve(path.dirname(importingFileAbs), specifier), workspaceRoot);
    }
    if (specifier.startsWith('$lib/')) {
        const rest = specifier.slice('$lib/'.length);
        // $lib points at the `src/lib` of the SvelteKit project the importing file belongs to.
        // In a monorepo the file lives in a sub-package, so derive that package's src dir from the
        // file's own path (its last `/src/` segment) rather than assuming the workspace root.
        const normalized = importingFileAbs.replace(/\\/g, '/');
        const srcIdx = normalized.lastIndexOf('/src/');
        const libBase = srcIdx !== -1
            ? `${normalized.slice(0, srcIdx)}/src/lib`
            : `${workspaceRoot.replace(/\\/g, '/')}/src/lib`;
        return toNodeId(`${libBase}/${rest}`, workspaceRoot);
    }
    return specifier.replace(/^\.\//, '');
}

/**
 * A node is a `route` only when it is a +page/+layout/+error file under the routes base path;
 * every other `.svelte` file (including components living inside the routes folder) is a component.
 */
export function getNodeType(file: string, routesBasePath: string): 'component' | 'route' {
    // Plain substring test (not a RegExp) so a routesBasePath containing regex
    // metacharacters can never throw or alter matching. Match the base after a slash OR at the
    // very start of the path (mirrors deriveRouteLabel), so a relative id like
    // `routes/+page.svelte` is still recognized as a route.
    const normalizedFile = file.replace(/\\/g, '/');
    if (normalizedFile.includes(`/${routesBasePath}/`) || normalizedFile.startsWith(`${routesBasePath}/`)) {
        const fileName = path.basename(file);
        if (fileName.startsWith('+page') || fileName.startsWith('+layout') || fileName.startsWith('+error')) {
            return 'route';
        }
    }
    return 'component';
}

// --- Display labels (ported from the extension's webview; string-ops only, no regex metachar risk) ---

/** Basename of a path id with the `.svelte` extension stripped. */
function basename(id: string): string {
    const seg = id.split('/').pop() || id;
    return seg.endsWith('.svelte') ? seg.slice(0, -'.svelte'.length) : seg;
}

function posixDirname(s: string): string {
    const i = s.lastIndexOf('/');
    return i === -1 ? '.' : s.slice(0, i);
}

/**
 * Derive a route's display label (e.g. `(page) /dashboard`) from its path id and the routes base.
 * Locates the base segment with plain string ops so a base containing regex metacharacters is safe.
 *
 * NOTE: unlike the VS Code extension's webview (which renders nested routes without a leading slash,
 * e.g. `(page) dashboard`), this server prefixes sub-paths with `/` so every label is a real route
 * path (`(page) /dashboard`, root `(page) /`). This is an intentional, sanctioned divergence — the
 * two projects are maintained independently.
 */
function deriveRouteLabel(id: string, base: string): string {
    const normalized = id.replace(/\\/g, '/');
    const marker = `/${base}/`;
    const idx = normalized.indexOf(marker);
    let afterBase: string;
    if (idx >= 0) {
        afterBase = normalized.slice(idx + marker.length);
    } else if (normalized.startsWith(`${base}/`)) {
        afterBase = normalized.slice(base.length + 1);
    } else {
        afterBase = normalized;
    }
    const fileName = afterBase.split('/').pop() || '';
    let fileType = '';
    if (fileName.startsWith('+page')) fileType = '(page)';
    else if (fileName.startsWith('+layout')) fileType = '(layout)';
    else if (fileName.startsWith('+error')) fileType = '(error)';
    const dir = posixDirname(afterBase);
    // Build the real URL path: drop SvelteKit route-group folders like `(auth)` (they don't appear
    // in the URL). Dynamic segments (`[slug]`, `[...rest]`) are kept. Root renders as '/'.
    const segments = (dir === '.' ? '' : dir)
        .split('/')
        .filter(seg => seg && !(seg.startsWith('(') && seg.endsWith(')')));
    return `${fileType} ${segments.length ? '/' + segments.join('/') : '/'}`;
}

/** The display label for a node: derived route string for routes, basename for components. */
function baseLabel(id: string, type: 'component' | 'route', routesBasePath: string): string {
    return type === 'route' ? deriveRouteLabel(id, routesBasePath) : basename(id);
}

/** One prop in a component's public API. */
export interface PropInfo {
    name: string;
    /** True when the prop has a default value (callers may omit it). */
    optional: boolean;
    /** True for a Svelte 5 `$bindable()` prop. */
    bindable: boolean;
    /** True for a runes `...rest` catch-all (the component forwards arbitrary extra props). */
    rest?: boolean;
}

/** A component's public surface: props it accepts and slots it exposes. */
export interface ComponentDetail {
    props: PropInfo[];
    slots: string[];
}

/**
 * The setting-independent result of parsing one file: which local names map to which child node
 * ids, which of those locals are referenced in the template, and the component's public API surface
 * (props/slots). The unconditional/unused decision is intentionally NOT cached here — it depends on
 * the unconditionalDependencyPaths option, which can change without the file's mtime changing, so it
 * is applied fresh at graph-assembly time.
 */
interface ParseResult {
    importsByLocal: Record<string, string>;
    usedLocals: Set<string>;
    props: PropInfo[];
    slots: string[];
}

function emptyParseResult(): ParseResult {
    return { importsByLocal: {}, usedLocals: new Set(), props: [], slots: [] };
}

/**
 * Extract a component's public API (Svelte 5) from its parsed AST: props from the `$props()`
 * destructuring, and slots from `<slot>` / `<slot name="x">`. Events are not a distinct concept in
 * Svelte 5 — they are ordinary callback props, so they surface under `props`.
 */
function extractDetail(ast: any): ComponentDetail {
    const props: PropInfo[] = [];
    const slots: string[] = [];
    const instanceBody: any[] = ast.instance?.content?.body ?? [];

    // Props: `let { a, b = 1, c = $bindable(), ...rest } = $props()`.
    for (const node of instanceBody) {
        if (node.type !== 'VariableDeclaration') {
            continue;
        }
        for (const decl of node.declarations) {
            if (
                decl.init?.type === 'CallExpression' &&
                decl.init.callee?.name === '$props' &&
                decl.id?.type === 'ObjectPattern'
            ) {
                for (const p of decl.id.properties) {
                    if (p.type === 'Property') {
                        // A computed key (`{ [k]: v }`) can't be named statically; a quoted key
                        // (`{ "data-x": v }`) is a Literal, not an Identifier.
                        if (p.computed) {
                            continue;
                        }
                        const name =
                            p.key?.type === 'Identifier' ? p.key.name
                            : p.key?.type === 'Literal' ? String(p.key.value)
                            : undefined;
                        if (!name) {
                            continue;
                        }
                        const hasDefault = p.value?.type === 'AssignmentPattern';
                        const bindable =
                            hasDefault &&
                            p.value.right?.type === 'CallExpression' &&
                            p.value.right.callee?.name === '$bindable';
                        props.push({ name, optional: hasDefault, bindable });
                    } else if (p.type === 'RestElement' && p.argument?.type === 'Identifier') {
                        props.push({ name: p.argument.name, optional: true, bindable: false, rest: true });
                    }
                }
            }
        }
    }

    // Slots: <slot> / <slot name="x"> in the template.
    if (ast.html) {
        walk(ast.html as any, {
            enter(node: any) {
                if (node.type === 'Slot') {
                    const nameAttr = (node.attributes || []).find((a: any) => a.name === 'name');
                    const name = nameAttr?.value?.[0]?.data ?? 'default';
                    if (!slots.includes(name)) {
                        slots.push(name);
                    }
                }
            }
        });
    }

    return { props, slots };
}

const parseCache = new Map<string, { mtimeMs: number; size: number; parsed: ParseResult }>();

// Bound the per-file parse cache so a long-lived server processing many files (branch switches,
// many worktrees) can't grow it without limit. Map preserves insertion order, so evicting the first
// key drops the least-recently-inserted entry (entries are re-inserted on refresh, keeping them warm).
const MAX_PARSE_CACHE_ENTRIES = 5000;

// Cache keys are normalized to POSIX separators so the walk-produced paths used when populating the
// cache and any path used to invalidate it match on Windows too.
function cacheKey(p: string): string {
    return p.replace(/\\/g, '/');
}

/** Drop a single file's cached parse (used to force a re-parse, e.g. on an explicit scan). */
export function invalidateParseCache(absPath: string): void {
    parseCache.delete(cacheKey(absPath));
}

function parseSvelteFile(file: string, workspaceRoot: string): ParseResult {
    const result = emptyParseResult();

    let source: string;
    try {
        source = fs.readFileSync(file, 'utf-8');
    } catch {
        return result;
    }

    try {
        const ast = svelte.parse(source);

        // Collect component imports (default + named) keyed by local binding.
        walk(ast as any, {
            enter(node: any) {
                if (
                    node.type === 'ImportDeclaration' &&
                    node.source?.value?.endsWith('.svelte')
                ) {
                    // Skip type-only imports (`import type Foo from './Foo.svelte'`) — they create no
                    // runtime dependency, so counting them produces a phantom edge + spurious "unused".
                    if (node.importKind === 'type') {
                        return;
                    }
                    const childId = resolveImportId(node.source.value, file, workspaceRoot);
                    for (const specifier of node.specifiers || []) {
                        if (specifier.importKind === 'type') {
                            continue; // inline `import { type Foo }`
                        }
                        if (specifier.local?.name) {
                            result.importsByLocal[specifier.local.name] = childId;
                        }
                    }
                }
            }
        });

        // Collect which imported locals are referenced in the template (static <Foo/> or
        // dynamic <svelte:component this={Foo}/>).
        walk(ast.html as any, {
            enter(node: any) {
                if (node.type !== 'InlineComponent') {
                    return;
                }
                let localName: string | undefined;
                if (node.name === 'svelte:component') {
                    if (node.expression?.type === 'Identifier') {
                        localName = node.expression.name;
                    }
                } else {
                    localName = node.name;
                }
                if (localName && result.importsByLocal[localName]) {
                    result.usedLocals.add(localName);
                }
            }
        });

        // Component API surface (props/slots) for the get_component tool.
        const detail = extractDetail(ast);
        result.props = detail.props;
        result.slots = detail.slots;
    } catch (e) {
        console.error(`Could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The cached result is shared by reference with every caller — treat it as read-only.
    // Freeze so an accidental future write is caught instead of silently poisoning the cache
    // (the Set can't be frozen meaningfully; assembly only reads it).
    Object.freeze(result.importsByLocal);
    Object.freeze(result.props);
    Object.freeze(result.slots);
    return result;
}

/**
 * Cache-aware parse: re-reads a file only when its mtime OR size has changed since the last
 * parse. Size is a cheap second signal that catches content changes which preserve mtime
 * (e.g. a `git checkout` that restores a stale timestamp). Pass `known` when the caller has already
 * stat'd the file (graph assembly) to avoid a redundant `statSync`.
 */
function getParsedFile(
    file: string,
    workspaceRoot: string,
    known?: { mtimeMs: number; size: number }
): ParseResult {
    let mtimeMs: number;
    let size: number;
    if (known) {
        mtimeMs = known.mtimeMs;
        size = known.size;
    } else {
        try {
            const stat = fs.statSync(file);
            mtimeMs = stat.mtimeMs;
            size = stat.size;
        } catch {
            return emptyParseResult();
        }
    }

    const key = cacheKey(file);
    const cached = parseCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.parsed;
    }

    const parsed = parseSvelteFile(file, workspaceRoot);
    parseCache.set(key, { mtimeMs, size, parsed });
    if (parseCache.size > MAX_PARSE_CACHE_ENTRIES) {
        const oldest = parseCache.keys().next().value;
        if (oldest !== undefined) {
            parseCache.delete(oldest);
        }
    }
    return parsed;
}

/**
 * The public API surface (props/slots) of a single component file. Reads through the same per-file
 * mtime+size cache as graph assembly, so after a graph build this is a cache hit; for a file outside
 * the scan (or a cold cache) it parses on demand. Missing files yield an empty detail.
 */
export function getComponentDetail(absPath: string, workspaceRoot: string): ComponentDetail {
    const { props, slots } = getParsedFile(absPath, workspaceRoot);
    return { props, slots };
}

/**
 * Visit every `.svelte` file under `root` (symlink-aware, cycle-guarded), skipping the ignore dirs.
 * The visitor may return `true` to stop the walk early. Directories are de-duplicated by real path so
 * a symlink cycle can't loop forever and a dir reached two ways isn't scanned twice.
 */
function forEachSvelteFile(root: string, visit: (file: string) => boolean | void): void {
    const stack: string[] = [root];
    const seenDirs = new Set<string>();
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let real: string;
        try {
            real = fs.realpathSync(dir);
        } catch {
            continue; // dangling/unreadable
        }
        if (seenDirs.has(real)) {
            continue;
        }
        seenDirs.add(real);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue; // unreadable dir → skip
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                // withFileTypes reports a symlink's own type, not its target's — resolve it so
                // symlinked dirs/files (common in pnpm/monorepo setups) are not silently skipped.
                try {
                    const st = fs.statSync(full);
                    isDir = st.isDirectory();
                    isFile = st.isFile();
                } catch {
                    continue; // dangling symlink
                }
            }
            if (isDir) {
                if (!IGNORED_DIRS.has(entry.name)) {
                    stack.push(full);
                }
            } else if (isFile && entry.name.endsWith('.svelte')) {
                if (visit(full) === true) {
                    return;
                }
            }
        }
    }
}

/**
 * Every `.svelte` file under `root` (absolute paths), sorted for deterministic, reproducible output.
 */
export function walkSvelteFiles(root: string): string[] {
    const found: string[] = [];
    forEachSvelteFile(root, file => {
        found.push(file);
    });
    found.sort();
    return found;
}

/** Cheap existence check: true if `root` contains at least one `.svelte` file (stops at the first). */
export function hasSvelteFile(root: string): boolean {
    let any = false;
    forEachSvelteFile(root, () => {
        any = true;
        return true; // stop early
    });
    return any;
}

/** A `.svelte` file selected for the graph, with the stat used both for the cache key and staleness. */
export interface ScanEntry {
    file: string; // absolute path
    id: string; // canonical node id
    mtimeMs: number;
    size: number;
}

/** Result of scanning a project: parse-ready entries plus an id→stamp map for cache staleness. */
export interface ProjectScan {
    entries: ScanEntry[];
    stamps: Map<string, string>; // id → "<mtimeMs>:<size>"
}

/**
 * Build the include predicate from the configured globs. A file is included when it matches at least
 * one positive pattern AND no negation pattern (`!…`). The previous `.some()` over a flat matcher list
 * could never subtract, so documented exclusion globs were silently ignored.
 */
function includePredicate(componentPatterns: string[], routePatterns: string[]): (id: string) => boolean {
    const all = [...componentPatterns, ...routePatterns];
    const positives = all.filter(p => !p.startsWith('!')).map(p => new Minimatch(p));
    const negatives = all.filter(p => p.startsWith('!')).map(p => new Minimatch(p.slice(1)));
    return (id: string) => positives.some(m => m.match(id)) && !negatives.some(m => m.match(id));
}

/**
 * Walk `root` once, keep only the `.svelte` files the include/exclude globs select, and stat each
 * exactly once. Only the INCLUDED files are stamped, so editing a `.svelte` file the globs exclude
 * never spuriously invalidates the graph cache.
 */
export function scanProject(root: string, options: ParserOptions = {}): ProjectScan {
    const componentPatterns = options.componentPaths ?? DEFAULT_COMPONENT_PATHS;
    const routePatterns = options.routePaths ?? DEFAULT_ROUTE_PATHS;
    const included = includePredicate(componentPatterns, routePatterns);

    const entries: ScanEntry[] = [];
    const stamps = new Map<string, string>();
    for (const file of walkSvelteFiles(root)) {
        const id = toNodeId(file, root);
        if (!included(id)) {
            continue;
        }
        let stat: fs.Stats;
        try {
            stat = fs.statSync(file);
        } catch {
            continue; // vanished between walk and stat
        }
        entries.push({ file, id, mtimeMs: stat.mtimeMs, size: stat.size });
        stamps.set(id, `${stat.mtimeMs}:${stat.size}`);
    }
    return { entries, stamps };
}

/**
 * Assemble the dependency graph from a project scan. Parses each included file (through the per-file
 * cache, reusing the scan's stat), then builds nodes and links. The `unused` flag is computed
 * GLOBALLY — a component is unused only if it is imported somewhere and rendered nowhere — so the
 * result never depends on file-traversal order.
 */
export function assembleGraph(root: string, options: ParserOptions, scan: ProjectScan): GraphData {
    const routesBasePath = options.routesBasePath ?? DEFAULT_ROUTES_BASE_PATH;
    const unconditionalMatchers = (options.unconditionalDependencyPaths ?? []).map(p => new Minimatch(p));

    const allNodes = new Map<string, GraphNode>();
    const links: GraphLink[] = [];
    const linkSet = new Set<string>(); // dedupes a file importing the same child under two bindings
    const importedChildren = new Set<string>(); // every id that is the target of some import
    const usedChildren = new Set<string>(); // ids actually rendered by at least one importer

    // Pass 1: authoritative node for every scanned file (correct type + label), plus edges/usage.
    for (const { file, id, mtimeMs, size } of scan.entries) {
        const type = getNodeType(file, routesBasePath);
        allNodes.set(id, { id, label: baseLabel(id, type, routesBasePath), type });

        const { importsByLocal, usedLocals } = getParsedFile(file, root, { mtimeMs, size });
        const isUnconditional = unconditionalMatchers.some(m => m.match(id));

        for (const [local, childId] of Object.entries(importsByLocal)) {
            if (childId === id) {
                continue; // ignore self-import
            }
            importedChildren.add(childId);
            if (isUnconditional || usedLocals.has(local)) {
                usedChildren.add(childId);
            }
            const key = `${id}\t${childId}`;
            if (!linkSet.has(key)) {
                linkSet.add(key);
                links.push({ source: id, target: childId });
            }
        }
    }

    // Pass 2: leaf nodes for imported children never scanned (outside the include set / bare alias).
    for (const childId of importedChildren) {
        if (!allNodes.has(childId)) {
            allNodes.set(childId, { id: childId, label: basename(childId), type: 'component' });
        }
    }

    // Pass 3: imported somewhere but rendered nowhere → unused. Order-independent by construction.
    for (const id of importedChildren) {
        if (!usedChildren.has(id)) {
            allNodes.get(id)!.unused = true;
        }
    }

    return { nodes: Array.from(allNodes.values()), links };
}

/**
 * Scan `root` for Svelte files and build the dependency graph. Pure Node.js — no editor APIs.
 * Returns `GraphData` with workspace-relative path ids and display labels.
 */
export function generateComponentGraph(root: string, options: ParserOptions = {}): GraphData {
    return assembleGraph(root, options, scanProject(root, options));
}
