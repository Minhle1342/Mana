import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeResult } from "../src/core/agent-session-runtime.ts";
import { SessionTabManager } from "../src/core/session-tab-manager.ts";

const cwd = process.cwd();

function mockSession(modelName = "model-1", sessionFile?: string): AgentSession {
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
		sessionManager: { getSessionFile: () => sessionFile },
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

function makeFactory() {
	return vi.fn(async (options: { cwd: string }) => {
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
}

function makeManager(onRuntimeCreated?: (runtime: AgentSessionRuntime, tabId: string) => void): SessionTabManager {
	return new SessionTabManager({
		firstRuntime: mockRuntime(),
		createRuntimeFactory: makeFactory(),
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

	it("renames an existing tab and trims the name", () => {
		const manager = makeManager();
		expect(manager.getTab("tab-1")?.isCustomNamed).toBe(false);
		expect(manager.renameTab("tab-1", "  Renamed Tab  ")).toBe(true);
		expect(manager.getTab("tab-1")?.name).toBe("Renamed Tab");
		expect(manager.getTab("tab-1")?.isCustomNamed).toBe(true);
	});

	it("preserves isCustomNamed when renameTab is called with isCustom = false", () => {
		const manager = makeManager();
		expect(manager.getTab("tab-1")?.isCustomNamed).toBe(false);
		expect(manager.renameTab("tab-1", "Auto Name", false)).toBe(true);
		expect(manager.getTab("tab-1")?.name).toBe("Auto Name");
		expect(manager.getTab("tab-1")?.isCustomNamed).toBe(false);
	});

	it("flags isCustomNamed when tab is created with explicit name", async () => {
		const manager = makeManager();
		const tab2 = await manager.addTab({ cwd, name: "Custom Tab 2" });
		expect(tab2.isCustomNamed).toBe(true);
		const tab3 = await manager.addTab({ cwd });
		expect(tab3.isCustomNamed).toBe(false);
	});

	it("rejects renaming with invalid id or blank name", () => {
		const manager = makeManager();
		expect(manager.renameTab("nonexistent", "New Name")).toBe(false);
		expect(manager.renameTab("tab-1", "   ")).toBe(false);
		expect(manager.getTab("tab-1")?.name).toBe("Tab 1");
	});

	it("snapshots display order, names, cwds, session files, and the active index", async () => {
		const manager = makeManager();
		await manager.addTab({ cwd, name: "Docs" });
		manager.renameTab("tab-2", "Notes");

		expect(manager.getActiveIndex()).toBe(0);
		expect(manager.snapshot()).toEqual({
			tabs: [
				{ name: "Tab 1", customName: false, cwd, sessionFile: null },
				{ name: "Notes", customName: true, cwd, sessionFile: null },
			],
			activeIndex: 0,
		});

		await manager.switchTab("tab-2");
		expect(manager.snapshot().activeIndex).toBe(1);
	});

	it("resumes the saved session file of a restored tab", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-tab-restore-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		try {
			const sessionFile = join(agentDir, "saved.jsonl");
			await writeFile(sessionFile, "", "utf-8");
			const createRuntimeFactory = makeFactory();
			const manager = new SessionTabManager({
				firstRuntime: mockRuntime(),
				createRuntimeFactory,
				agentDir,
				name: "Tab 1",
			});

			await manager.addTab({ cwd: agentDir, name: "Restored", sessionFile });

			const options = createRuntimeFactory.mock.calls[0]?.[0] as {
				cwd: string;
				sessionManager: { getSessionFile(): string | undefined; getCwd(): string };
			};
			expect(options.cwd).toBe(agentDir);
			expect(options.sessionManager.getSessionFile()).toBe(sessionFile);
			expect(options.sessionManager.getCwd()).toBe(agentDir);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("starts a restored tab empty when its session file is gone", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-tab-gone-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		try {
			const missing = join(agentDir, "anymore", "gone.jsonl");
			const createRuntimeFactory = makeFactory();
			const manager = new SessionTabManager({
				firstRuntime: mockRuntime(),
				createRuntimeFactory,
				agentDir,
				name: "Tab 1",
			});

			await manager.addTab({ cwd: agentDir, name: "Restored", sessionFile: missing });

			const options = createRuntimeFactory.mock.calls[0]?.[0] as unknown as {
				sessionManager: { getSessionFile(): string | undefined };
			};
			expect(options.sessionManager.getSessionFile()).not.toBe(missing);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
