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
    // metacharacters can never throw or alter matching.
    const normalizedFile = file.replace(/\\/g, '/');
    if (normalizedFile.includes(`/${routesBasePath}/`)) {
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
    // Root route (posixDirname returns '.') renders as '/'; nested routes get a leading slash.
    return `${fileType} ${dir && dir !== '.' ? '/' + dir : '/'}`;
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

/** A component's public surface: props it accepts, slots it exposes, events it dispatches. */
export interface ComponentDetail {
    props: PropInfo[];
    slots: string[];
    events: string[];
}

/**
 * The setting-independent result of parsing one file: which local names map to which child node
 * ids, which of those locals are referenced in the template, and the component's public API surface
 * (props/slots/events). The unconditional/unused decision is intentionally NOT cached here — it
 * depends on the unconditionalDependencyPaths option, which can change without the file's mtime
 * changing, so it is applied fresh at graph-assembly time.
 */
interface ParseResult {
    importsByLocal: Record<string, string>;
    usedLocals: Set<string>;
    props: PropInfo[];
    slots: string[];
    events: string[];
}

function emptyParseResult(): ParseResult {
    return { importsByLocal: {}, usedLocals: new Set(), props: [], slots: [], events: [] };
}

/**
 * Extract a component's public API from its parsed AST: props (Svelte 5 `$props()` destructuring
 * and legacy `export let`), slots (`<slot>` / `<slot name="x">`), and dispatched events (legacy
 * `createEventDispatcher`). Runes components express events as callback props, so they surface in
 * `props` rather than `events` — that is expected.
 */
function extractDetail(ast: any): ComponentDetail {
    const props: PropInfo[] = [];
    const slots: string[] = [];
    const events: string[] = [];
    const instanceBody: any[] = ast.instance?.content?.body ?? [];

    for (const node of instanceBody) {
        // Legacy props: `export let foo` / `export let foo = default` (export const is read-only).
        if (
            node.type === 'ExportNamedDeclaration' &&
            node.declaration?.type === 'VariableDeclaration' &&
            (node.declaration.kind === 'let' || node.declaration.kind === 'var')
        ) {
            for (const decl of node.declaration.declarations) {
                if (decl.id?.type === 'Identifier') {
                    props.push({ name: decl.id.name, optional: decl.init != null, bindable: false });
                }
            }
        }
        // Runes props: `let { a, b = 1, c = $bindable(), ...rest } = $props()`.
        if (node.type === 'VariableDeclaration') {
            for (const decl of node.declarations) {
                if (
                    decl.init?.type === 'CallExpression' &&
                    decl.init.callee?.name === '$props' &&
                    decl.id?.type === 'ObjectPattern'
                ) {
                    for (const p of decl.id.properties) {
                        if (p.type === 'Property') {
                            const hasDefault = p.value?.type === 'AssignmentPattern';
                            const bindable =
                                hasDefault &&
                                p.value.right?.type === 'CallExpression' &&
                                p.value.right.callee?.name === '$bindable';
                            props.push({ name: p.key.name, optional: hasDefault, bindable });
                        } else if (p.type === 'RestElement' && p.argument?.type === 'Identifier') {
                            props.push({ name: p.argument.name, optional: true, bindable: false, rest: true });
                        }
                    }
                }
            }
        }
    }

    // Slots (legacy markup; runes use snippet/children props, already captured above).
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

    // Events: legacy `const dispatch = createEventDispatcher()` then `dispatch('name', …)`.
    let dispatcherName: string | undefined;
    for (const node of instanceBody) {
        if (node.type === 'VariableDeclaration') {
            for (const decl of node.declarations) {
                if (
                    decl.init?.type === 'CallExpression' &&
                    decl.init.callee?.name === 'createEventDispatcher' &&
                    decl.id?.type === 'Identifier'
                ) {
                    dispatcherName = decl.id.name;
                }
            }
        }
    }
    if (dispatcherName && ast.instance) {
        walk(ast.instance as any, {
            enter(node: any) {
                if (
                    node.type === 'CallExpression' &&
                    node.callee?.type === 'Identifier' &&
                    node.callee.name === dispatcherName
                ) {
                    const arg = node.arguments?.[0];
                    if (arg?.type === 'Literal' && typeof arg.value === 'string' && !events.includes(arg.value)) {
                        events.push(arg.value);
                    }
                }
            }
        });
    }

    return { props, slots, events };
}

const parseCache = new Map<string, { mtimeMs: number; size: number; parsed: ParseResult }>();

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
                    const childId = resolveImportId(node.source.value, file, workspaceRoot);
                    for (const specifier of node.specifiers || []) {
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

        // Component API surface (props/slots/events) for the get_component tool.
        const detail = extractDetail(ast);
        result.props = detail.props;
        result.slots = detail.slots;
        result.events = detail.events;
    } catch (e) {
        console.error(`Could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The cached result is shared by reference with every caller — treat it as read-only.
    // Freeze so an accidental future write is caught instead of silently poisoning the cache
    // (the Set can't be frozen meaningfully; assembly only reads it).
    Object.freeze(result.importsByLocal);
    Object.freeze(result.props);
    Object.freeze(result.slots);
    Object.freeze(result.events);
    return result;
}

/**
 * Cache-aware parse: re-reads a file only when its mtime OR size has changed since the last
 * parse. Size is a cheap second signal that catches content changes which preserve mtime
 * (e.g. a `git checkout` that restores a stale timestamp).
 */
function getParsedFile(file: string, workspaceRoot: string): ParseResult {
    let mtimeMs: number;
    let size: number;
    try {
        const stat = fs.statSync(file);
        mtimeMs = stat.mtimeMs;
        size = stat.size;
    } catch {
        return emptyParseResult();
    }

    const key = cacheKey(file);
    const cached = parseCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.parsed;
    }

    const parsed = parseSvelteFile(file, workspaceRoot);
    parseCache.set(key, { mtimeMs, size, parsed });
    return parsed;
}

/**
 * The public API surface (props/slots/events) of a single component file. Reads through the same
 * per-file mtime+size cache as graph assembly, so after a `generateComponentGraph` run this is a
 * cache hit; for a file outside the scan (or a cold cache) it parses on demand. Missing files
 * yield an empty detail.
 */
export function getComponentDetail(absPath: string, workspaceRoot: string): ComponentDetail {
    const { props, slots, events } = getParsedFile(absPath, workspaceRoot);
    return { props, slots, events };
}

/**
 * Recursively collect every `.svelte` file under `root` (absolute paths), skipping the ignore dirs.
 * Replaces the extension's `glob()` scan; the cache reuses this to enumerate the current file set.
 */
export function walkSvelteFiles(root: string): string[] {
    const found: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue; // unreadable dir → skip
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) {
                    stack.push(full);
                }
            } else if (entry.isFile() && entry.name.endsWith('.svelte')) {
                found.push(full);
            }
        }
    }
    return found;
}

/**
 * Scan `root` for Svelte files and build the dependency graph. Pure Node.js — no editor APIs.
 * Returns `GraphData` with workspace-relative path ids and display labels.
 */
export function generateComponentGraph(root: string, options: ParserOptions = {}): GraphData {
    const componentPatterns = options.componentPaths ?? DEFAULT_COMPONENT_PATHS;
    const routePatterns = options.routePaths ?? DEFAULT_ROUTE_PATHS;
    const routesBasePath = options.routesBasePath ?? DEFAULT_ROUTES_BASE_PATH;
    const unconditionalDependencyPaths = options.unconditionalDependencyPaths ?? [];

    // Compile the include + unconditional globs once. Includes are matched against each file's
    // workspace-relative id (POSIX), the same form the extension's glob patterns assume.
    const includeMatchers = [...componentPatterns, ...routePatterns].map(pattern => new Minimatch(pattern));
    const unconditionalMatchers = unconditionalDependencyPaths.map(pattern => new Minimatch(pattern));

    const svelteFiles = walkSvelteFiles(root).filter(file => {
        const nodeId = toNodeId(file, root);
        return includeMatchers.some(matcher => matcher.match(nodeId));
    });

    const dependencyMap: Record<string, Set<string>> = {};
    const allNodes = new Map<string, GraphNode>();

    for (const file of svelteFiles) {
        const nodeId = toNodeId(file, root);
        const nodeType = getNodeType(file, routesBasePath);

        if (!allNodes.has(nodeId)) {
            allNodes.set(nodeId, { id: nodeId, label: baseLabel(nodeId, nodeType, routesBasePath), type: nodeType });
        }
        dependencyMap[nodeId] = new Set();

        const { importsByLocal, usedLocals } = getParsedFile(file, root);

        // Files matching a configured glob treat all their .svelte imports as dependencies,
        // regardless of template usage (e.g. dynamic renderers that resolve children at runtime).
        const isUnconditional = unconditionalMatchers.some(matcher => matcher.match(nodeId));

        const addChild = (childName: string, unused: boolean) => {
            if (childName === nodeId) {
                return; // Avoid self-reference
            }
            dependencyMap[nodeId].add(childName);
            if (!allNodes.has(childName)) {
                // Imported children are always components (a leaf node when outside the scan set).
                const node: GraphNode = { id: childName, label: basename(childName), type: 'component' };
                if (unused) {
                    node.unused = true;
                }
                allNodes.set(childName, node);
            }
        };

        // Classify each import; add the used/unconditional ones first so a child that is used
        // under one binding is never demoted to "unused" by another binding of the same file.
        const unusedChildren: string[] = [];
        for (const [localName, childName] of Object.entries(importsByLocal)) {
            if (isUnconditional || usedLocals.has(localName)) {
                addChild(childName, false);
            } else {
                unusedChildren.push(childName);
            }
        }
        for (const childName of unusedChildren) {
            addChild(childName, true);
        }
    }

    const graph: GraphData = {
        nodes: Array.from(allNodes.values()),
        links: []
    };

    for (const parent in dependencyMap) {
        for (const child of dependencyMap[parent]) {
            graph.links.push({ source: parent, target: child });
        }
    }

    return graph;
}
