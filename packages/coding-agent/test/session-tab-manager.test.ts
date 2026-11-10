import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeResult } from "../src/core/agent-session-runtime.ts";
import { SessionTabManager } from "../src/core/session-tab-manager.ts";

const cwd = process.cwd();

function mockSession(modelName = "model-1"): AgentSession {
	let currentModel = { id: modelName, provider: "test" } as unknown as Model<any>;
	return {
		cwd,
		get model() {
			return currentModel;
		},
		setModel: vi.fn(async (model: Model<any>, _options?: { persist?: boolean }) => {
			currentModel = model;
		}),
		prompt: vi.fn(async (_text: string) => {}),
		isStreaming: false,
		dispose: vi.fn(),
		abort: vi.fn(),
		extensionRunner: { hasHandlers: () => false },
	} as unknown as AgentSession;
}

function mockRuntime(initialCwd = cwd, initialModel = "model-1"): AgentSessionRuntime {
	let currentSession = mockSession(initialModel);
	let currentCwd = initialCwd;
	return {
		get cwd() {
			return currentCwd;
		},
		set cwd(val: string) {
			currentCwd = val;
		},
		get session() {
			return currentSession;
		},
		set session(val: AgentSession) {
			currentSession = val;
		},
		dispose: vi.fn(),
		services: {
			agentDir: "/tmp/agent",
			modelRuntime: { settleCredentialWrites: vi.fn() },
		},
	} as unknown as AgentSessionRuntime;
}

function makeManager(onRuntimeCreated?: (runtime: AgentSessionRuntime, tabId: string) => void): SessionTabManager {
	const createRuntimeFactory = vi.fn(async (options: { cwd: string }) => {
		const session = mockSession();
		return {
			session,
			services: {
				agentDir: "/tmp/agent",
				cwd: options.cwd,
				modelRuntime: { settleCredentialWrites: vi.fn() },
			},
			diagnostics: [],
			modelFallbackMessage: undefined,
			extensionsResult: undefined as unknown as never,
		} as unknown as CreateAgentSessionRuntimeResult;
	});
	return new SessionTabManager({
		firstRuntime: mockRuntime(),
		createRuntimeFactory,
		agentDir: "/tmp/agent",
		name: "Tab 1",
		onRuntimeCreated,
	});
}

describe("SessionTabManager", () => {
	it("starts with one tab and exposes it as active", () => {
		const manager = makeManager();
		expect(manager.getAllTabs()).toHaveLength(1);
		expect(manager.getActiveTab()?.id).toBe("tab-1");
		expect(manager.getActiveTab()?.name).toBe("Tab 1");
		expect(manager.getActiveSession()).toBeDefined();
		expect(manager.getActiveRuntime()).toBeDefined();
	});

	it("adds a tab without switching to it", async () => {
		const manager = makeManager();
		const slot = await manager.addTab({ cwd, name: "Tab 2" });
		expect(manager.getAllTabs()).toHaveLength(2);
		expect(manager.getActiveTab()?.id).toBe("tab-1");
		expect(slot.id).toBe("tab-2");
		expect(slot.name).toBe("Tab 2");
		expect(slot.cwd).toBe(cwd);
	});

	it("switches the active tab", async () => {
		const manager = makeManager();
		const slot = await manager.addTab({ cwd, name: "Tab 2" });
		expect(await manager.switchTab(slot.id)).toBe(true);
		expect(manager.getActiveTab()?.id).toBe(slot.id);
		expect(manager.getActiveSession()).toBe(slot.session);
		// switching to the same tab is a no-op
		expect(await manager.switchTab(slot.id)).toBe(false);
	});

	it("removes a tab and falls back to another tab", async () => {
		const manager = makeManager();
		const slot = await manager.addTab({ cwd, name: "Tab 2" });
		await manager.switchTab(slot.id);
		expect(await manager.removeTab(slot.id)).toBe(true);
		expect(manager.getAllTabs()).toHaveLength(1);
		expect(manager.getActiveTab()?.id).toBe("tab-1");
	});

	it("disposes removed tab runtime", async () => {
		const manager = makeManager();
		const slot = await manager.addTab({ cwd, name: "Tab 2" });
		const disposeSpy = vi.spyOn(slot.runtime, "dispose");
		await manager.removeTab(slot.id);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("exposes distinct sessions per tab", async () => {
		const manager = makeManager();
		const slot = await manager.addTab({ cwd, name: "Tab 2" });
		expect(manager.getActiveSession()).not.toBe(slot.session);
		expect(manager.getAllTabs().map((t) => t.session)).toHaveLength(
			new Set(manager.getAllTabs().map((t) => t.session)).size,
		);
	});

	it("generates monotonic tab IDs avoiding collision after removal", async () => {
		const manager = makeManager();
		const tab2 = await manager.addTab({ cwd, name: "Tab 2" });
		expect(tab2.id).toBe("tab-2");
		await manager.removeTab(tab2.id);
		const tab3 = await manager.addTab({ cwd, name: "Tab 3" });
		expect(tab3.id).toBe("tab-3");
		expect(manager.getTab("tab-2")).toBeUndefined();
		expect(manager.getTab("tab-3")).toBeDefined();
	});

	it("supports getNextTabId and getPrevTabId cyclic navigation", async () => {
		const manager = makeManager();
		const tab2 = await manager.addTab({ cwd, name: "Tab 2" });
		const tab3 = await manager.addTab({ cwd, name: "Tab 3" });

		// Currently active: tab-1
		expect(manager.getNextTabId()).toBe(tab2.id);
		expect(manager.getPrevTabId()).toBe(tab3.id);

		await manager.switchTab(tab2.id);
		expect(manager.getNextTabId()).toBe(tab3.id);
		expect(manager.getPrevTabId()).toBe("tab-1");
	});

	it("allows per-tab model switching with persist: false", async () => {
		const manager = makeManager();
		const tab2 = await manager.addTab({ cwd, name: "Tab 2" });
		const customModel = { id: "custom-model", provider: "test" } as unknown as Model<any>;

		await manager.setTabModel(tab2.id, customModel);
		expect(tab2.session.setModel).toHaveBeenCalledWith(customModel, { persist: false });
	});

	it("executes concurrent prompts on two tabs without blocking", async () => {
		const manager = makeManager();
		const tab2 = await manager.addTab({ cwd, name: "Tab 2" });

		let resolvePrompt1: () => void = () => {};
		let resolvePrompt2: () => void = () => {};

		const prompt1Started = new Promise<void>((r) => {
			vi.spyOn(manager.getActiveSession()!, "prompt").mockImplementation(async () => {
				r();
				await new Promise<void>((done) => {
					resolvePrompt1 = done;
				});
			});
		});

		const prompt2Started = new Promise<void>((r) => {
			vi.spyOn(tab2.session, "prompt").mockImplementation(async () => {
				r();
				await new Promise<void>((done) => {
					resolvePrompt2 = done;
				});
			});
		});

		// Trigger concurrent prompts on tab 1 and tab 2
		const p1 = manager.getActiveSession()!.prompt("Task 1");
		const p2 = tab2.session.prompt("Task 2");

		// Both prompts should have started concurrently
		await Promise.all([prompt1Started, prompt2Started]);

		// Settle both
		resolvePrompt1();
		resolvePrompt2();
		await Promise.all([p1, p2]);
	});

	it("invokes onRuntimeCreated hook when tab is added", async () => {
		const onCreated = vi.fn();
		const manager = makeManager(onCreated);
		// Called for first runtime
		expect(onCreated).toHaveBeenCalledWith(expect.anything(), "tab-1");

		await manager.addTab({ cwd, name: "Tab 2" });
		expect(onCreated).toHaveBeenCalledWith(expect.anything(), "tab-2");
	});
});
