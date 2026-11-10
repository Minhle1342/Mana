/**
 * SessionTabManager - multi-tab session container.
 *
 * Each tab owns an independent AgentSession + AgentSessionRuntime (its own cwd,
 * model, and in-flight run). Tabs run concurrently: each AgentSession has its
 * own Agent with its own activeRun guard, so prompt() on one tab never blocks
 * prompt() on another. The manager tracks one active tab whose UI the host
 * renders.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "./agent-session-runtime.ts";
import { createAgentSessionRuntime } from "./agent-session-runtime.ts";
import type { SessionStartEvent } from "./extensions/index.ts";
import { SessionManager } from "./session-manager.ts";

export interface TabSlot {
	id: string;
	name: string;
	readonly cwd: string;
	readonly session: AgentSession;
	readonly runtime: AgentSessionRuntime;
	isCustomNamed?: boolean;
}

export interface SessionTabManagerOptions {
	firstRuntime: AgentSessionRuntime;
	createRuntimeFactory: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	name?: string;
	onRuntimeCreated?: (runtime: AgentSessionRuntime, tabId: string) => void;
}

export class SessionTabManager {
	private readonly createRuntimeFactory: CreateAgentSessionRuntimeFactory;
	private readonly agentDir: string;
	private readonly onRuntimeCreated?: (runtime: AgentSessionRuntime, tabId: string) => void;
	private tabs = new Map<string, TabSlot>();
	private activeId: string | undefined;
	private nextTabNum = 1;

	constructor(options: SessionTabManagerOptions) {
		this.createRuntimeFactory = options.createRuntimeFactory;
		this.agentDir = options.agentDir;
		this.onRuntimeCreated = options.onRuntimeCreated;
		const { firstRuntime, name } = options;
		firstRuntime.session.autoNameFirstTurn = true;
		const id = `tab-${this.nextTabNum++}`;
		const isCustomNamed = name !== undefined && name !== "Tab 1";
		const slot: TabSlot = {
			id,
			name: name ?? "Tab 1",
			isCustomNamed,
			runtime: firstRuntime,
			get cwd() {
				return firstRuntime.cwd;
			},
			get session() {
				return firstRuntime.session;
			},
		};
		this.tabs.set(slot.id, slot);
		this.activeId = slot.id;
		if (this.onRuntimeCreated) {
			this.onRuntimeCreated(firstRuntime, id);
		}
	}

	getActiveTab(): TabSlot | undefined {
		return this.activeId === undefined ? undefined : this.tabs.get(this.activeId);
	}

	getActiveSession(): AgentSession | undefined {
		return this.getActiveTab()?.session;
	}

	getActiveRuntime(): AgentSessionRuntime | undefined {
		return this.getActiveTab()?.runtime;
	}

	getAllTabs(): readonly TabSlot[] {
		return [...this.tabs.values()];
	}

	getTab(id: string): TabSlot | undefined {
		return this.tabs.get(id);
	}

	renameTab(id: string, name: string, isCustom = true): boolean {
		const slot = this.tabs.get(id);
		const trimmed = name.trim();
		if (!slot || trimmed.length === 0) return false;
		slot.name = trimmed;
		if (isCustom) {
			slot.isCustomNamed = true;
		}
		return true;
	}

	getTabModel(id: string): Model<any> | undefined {
		return this.tabs.get(id)?.session.model;
	}

	async setTabModel(id: string, model: Model<any>): Promise<void> {
		const slot = this.tabs.get(id);
		if (!slot) throw new Error(`Tab not found: ${id}`);
		await slot.session.setModel(model, { persist: false });
	}

	getNextTabId(): string | undefined {
		const all = this.getAllTabs();
		if (all.length <= 1 || !this.activeId) return undefined;
		const index = all.findIndex((t) => t.id === this.activeId);
		if (index === -1) return undefined;
		const nextIndex = (index + 1) % all.length;
		return all[nextIndex].id;
	}

	getPrevTabId(): string | undefined {
		const all = this.getAllTabs();
		if (all.length <= 1 || !this.activeId) return undefined;
		const index = all.findIndex((t) => t.id === this.activeId);
		if (index === -1) return undefined;
		const prevIndex = (index - 1 + all.length) % all.length;
		return all[prevIndex].id;
	}

	async addTab(options: { cwd: string; name?: string; sessionStartEvent?: SessionStartEvent }): Promise<TabSlot> {
		const id = `tab-${this.nextTabNum++}`;
		const defaultName = `Tab ${this.nextTabNum - 1}`;
		const name = options.name ?? defaultName;
		const isCustomNamed = options.name !== undefined && options.name !== defaultName;
		const sessionManager = SessionManager.create(options.cwd);
		const runtime = await createAgentSessionRuntime(this.createRuntimeFactory, {
			cwd: options.cwd,
			agentDir: this.agentDir,
			sessionManager,
			sessionStartEvent: options.sessionStartEvent,
		});
		runtime.session.autoNameFirstTurn = true;
		if (this.onRuntimeCreated) {
			this.onRuntimeCreated(runtime, id);
		}
		const slot: TabSlot = {
			id,
			name,
			isCustomNamed,
			runtime,
			get cwd() {
				return runtime.cwd;
			},
			get session() {
				return runtime.session;
			},
		};
		this.tabs.set(id, slot);
		if (this.activeId === undefined) this.activeId = id;
		return slot;
	}

	async switchTab(id: string): Promise<boolean> {
		const slot = this.tabs.get(id);
		if (!slot || id === this.activeId) return false;
		this.activeId = id;
		return true;
	}

	async removeTab(id: string): Promise<boolean> {
		const slot = this.tabs.get(id);
		if (!slot) return false;
		await slot.runtime.dispose();
		this.tabs.delete(id);
		if (this.activeId === id) {
			this.activeId = undefined;
			const remaining = this.getAllTabs()[0];
			if (remaining) this.activeId = remaining.id;
		}
		return true;
	}
}
