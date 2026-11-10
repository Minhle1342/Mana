/**
 * TabStateStore - the tab layout of each workspace, persisted under the agent directory.
 *
 * A workspace record holds its tabs in display order with their names, working
 * directories, and session files, plus the index of the active tab. Writes are
 * locked and atomic, so a crash or a sibling pi instance never leaves a partial
 * file, and a file this version cannot read means "no saved tabs", never a
 * startup failure.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getTabsPath } from "../config.ts";
import { canonicalizePath, pathsEqual, resolvePath } from "../utils/paths.ts";

/** One tab as it is restored: a name, its working directory, and the session it resumes. */
export interface PersistedTab {
	name: string;
	customName: boolean;
	cwd: string;
	sessionFile: string | null;
}

/** The tab layout of one workspace, as the session tab manager reports it. */
export interface TabLayout {
	tabs: PersistedTab[];
	activeIndex: number;
}

/** A workspace record as stored on disk. */
export interface PersistedWorkspace extends TabLayout {
	updatedAt: string;
}

interface TabStateFile {
	version: typeof TAB_STATE_VERSION;
	workspaces: Record<string, PersistedWorkspace>;
}

const TAB_STATE_VERSION = 1;
const MAX_WORKSPACES = 32;

export class TabStateStore {
	private readonly tabsPath: string;

	constructor(agentDir: string) {
		this.tabsPath = getTabsPath(agentDir);
	}

	/** The saved layout for `cwd`, or undefined when that workspace was never saved. */
	load(cwd: string): PersistedWorkspace | undefined {
		const key = canonicalizePath(resolvePath(cwd));
		for (const [saved, workspace] of Object.entries(this.read().workspaces)) {
			if (pathsEqual(saved, key)) return workspace;
		}
		return undefined;
	}

	/** Replace the saved layout for `cwd`, stamping it and pruning the oldest workspaces. */
	save(cwd: string, layout: TabLayout): void {
		const key = canonicalizePath(resolvePath(cwd));
		withLock(this.tabsPath, () => {
			const file = this.read();
			for (const saved of Object.keys(file.workspaces)) {
				if (pathsEqual(saved, key)) delete file.workspaces[saved];
			}
			file.workspaces[key] = { ...layout, updatedAt: new Date().toISOString() };
			prune(file.workspaces);
			this.write(file);
		});
	}

	private read(): TabStateFile {
		if (!existsSync(this.tabsPath)) return emptyState();
		try {
			return parseTabState(JSON.parse(readFileSync(this.tabsPath, "utf-8")));
		} catch {
			return emptyState();
		}
	}

	/** Write through a temp sibling and rename, so the canonical path is never a partial file. */
	private write(file: TabStateFile): void {
		const temp = `${this.tabsPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		mkdirSync(dirname(this.tabsPath), { recursive: true });
		try {
			writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
			renameSync(temp, this.tabsPath);
		} catch (error: unknown) {
			rmSync(temp, { force: true });
			throw error;
		}
	}
}

function emptyState(): TabStateFile {
	return { version: TAB_STATE_VERSION, workspaces: {} };
}

/**
 * Trust boundary: tabs.json is user-editable and written by other pi versions.
 * A version, field, or value this version does not know means "no saved tabs".
 */
function parseTabState(value: unknown): TabStateFile {
	if (typeof value !== "object" || value === null) return emptyState();
	const file = value as { version?: unknown; workspaces?: unknown };
	if (file.version !== TAB_STATE_VERSION) return emptyState();
	if (typeof file.workspaces !== "object" || file.workspaces === null) return emptyState();
	const workspaces: Record<string, PersistedWorkspace> = {};
	for (const [key, entry] of Object.entries(file.workspaces)) {
		const workspace = parseWorkspace(entry);
		if (workspace) workspaces[key] = workspace;
	}
	return { version: TAB_STATE_VERSION, workspaces };
}

function parseWorkspace(value: unknown): PersistedWorkspace | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const entry = value as { tabs?: unknown; activeIndex?: unknown; updatedAt?: unknown };
	if (!Array.isArray(entry.tabs)) return undefined;
	if (typeof entry.activeIndex !== "number" || typeof entry.updatedAt !== "string") return undefined;
	const tabs: PersistedTab[] = [];
	for (const raw of entry.tabs) {
		const tab = parseTab(raw);
		if (!tab) return undefined;
		tabs.push(tab);
	}
	return { tabs, activeIndex: entry.activeIndex, updatedAt: entry.updatedAt };
}

function parseTab(value: unknown): PersistedTab | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const tab = value as { name?: unknown; customName?: unknown; cwd?: unknown; sessionFile?: unknown };
	if (typeof tab.name !== "string" || typeof tab.customName !== "boolean" || typeof tab.cwd !== "string")
		return undefined;
	if (tab.sessionFile !== null && typeof tab.sessionFile !== "string") return undefined;
	return { name: tab.name, customName: tab.customName, cwd: tab.cwd, sessionFile: tab.sessionFile };
}

/** Keep the most recently saved workspaces so the file cannot grow without bound. */
function prune(workspaces: Record<string, PersistedWorkspace>): void {
	const keys = Object.keys(workspaces);
	if (keys.length <= MAX_WORKSPACES) return;
	keys.sort((left, right) => workspaces[right].updatedAt.localeCompare(workspaces[left].updatedAt));
	for (const key of keys.slice(MAX_WORKSPACES)) delete workspaces[key];
}

function withLock<T>(path: string, fn: () => T): T {
	mkdirSync(dirname(path), { recursive: true });
	const release = acquireLock(path);
	try {
		return fn();
	} finally {
		release();
	}
}

/** Retry briefly: the holder is a sibling pi instance writing the same small file. */
function acquireLock(path: string): () => void {
	const attempts = 10;
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(dirname(path), { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error: unknown) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "ELOCKED" || attempt === attempts) throw error;
			const start = Date.now();
			while (Date.now() - start < 20) {
				// Block: callers are synchronous tab actions and shutdown.
			}
		}
	}
}
