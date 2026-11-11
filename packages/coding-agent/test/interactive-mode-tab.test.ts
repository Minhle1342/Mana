import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type TuiMouseEvent, VStack } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { TabSlot } from "../src/core/session-tab-manager.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { TabBar } from "../src/modes/interactive/components/tab-bar.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type InteractiveModeTabContext = {
	tabManager: {
		getAllTabs: () => readonly TabSlot[];
		getActiveTab: () => TabSlot | undefined;
		getNextTabId: () => string | undefined;
		getPrevTabId: () => string | undefined;
		switchTab: (id: string) => Promise<boolean>;
		addTab: (options: { cwd: string; name?: string }) => Promise<TabSlot>;
		removeTab: (id: string) => Promise<boolean>;
		renameTab: (id: string, name: string, isCustom?: boolean) => boolean;
		snapshot: () => { tabs: unknown[]; activeIndex: number };
	};
	activeTabRuntime: {
		newSession: () => Promise<{ cancelled: boolean }>;
	};
	sessionManager: {
		getCwd: () => string;
	};
	chatContainer: Container;
	outputPad: number;
	ui: {
		requestRender: () => void;
	};
	showStatus: (msg: string) => void;
	showError: (msg: string) => void;
	switchTab: (id: string) => Promise<void>;
	switchNextTab: () => Promise<void>;
	switchPrevTab: () => Promise<void>;
	addTab: (cwd?: string, name?: string) => Promise<TabSlot>;
	closeTab: (id: string) => Promise<void>;
	refreshTabBar: () => void;
	updateTerminalTitle: () => void;
	handleClearCommand: () => Promise<void>;
	clearStatusIndicator: (kind?: string) => void;
	findTabBySpec: (spec: string) => TabSlot | undefined;
	handleTabCommand: (text: string) => Promise<void>;
	handleEvent: (event: unknown, slot?: TabSlot) => Promise<void>;
	setupTabListeners: (slot: TabSlot) => void;
	retryUiByTab: Map<string, TabRetryUiStateFixture>;
	isInitialized: boolean;
	pendingTools: Map<string, unknown>;
	footer: { invalidate: () => void };
	programStatus: { handleEvent: (event: unknown) => void; reset: () => void };
	defaultEditor: { onEscape?: () => void };
	statusContainer: Container;
	activeStatusIndicator: StatusIndicatorFixture | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	setEditorWorkingStatusIndicator: (indicator: unknown) => boolean;
	showStatusIndicator: (indicator: StatusIndicatorFixture) => void;
	rebindCurrentSession: (options?: { renderBeforeBind?: boolean }) => Promise<void>;
	configureTabRuntime: (runtime: AgentSessionRuntime, tabId: string) => void;
	tabState: {
		load: (cwd: string) => PersistedWorkspaceFixture | undefined;
		save: (cwd: string, layout: unknown) => void;
	};
	workspaceKey: string;
	options: { restoreTabs?: boolean };
	saveTabState: () => void;
	restoreTabState: () => Promise<void>;
	resumeFirstTabSession: (tab: PersistedWorkspaceFixture["tabs"][number]) => Promise<boolean>;
	showWarning: (message: string) => void;
	isRestoringTabs: boolean;
};

type PersistedWorkspaceFixture = {
	tabs: { name: string; customName: boolean; cwd: string; sessionFile: string | null }[];
	activeIndex: number;
	updatedAt: string;
};

type StatusIndicatorFixture = { kind: string; dispose: () => void };

type TabRetryUiStateFixture = {
	autoRetry: boolean;
	onEscape?: () => void;
	indicator?: StatusIndicatorFixture;
	pendingRetry?: { attempt: number; maxAttempts: number; delayMs: number };
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModeTabContext;

function createMockTab(id: string, name: string, cwd = "/work/dir", isStreaming = false, isPersisted = true): TabSlot {
	return {
		id,
		name,
		cwd,
		session: {
			isStreaming,
			prompt: vi.fn(async () => {}),
			sessionManager: { isPersisted: () => isPersisted, getSessionFile: () => null },
		} as unknown as any,
		runtime: {
			cwd,
			session: {} as any,
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime,
	};
}

function makeMouseEvent(
	type: "click" | "press" | "move",
	x: number,
	y = 0,
	button: "left" | "middle" | "right" | "none" = "left",
): TuiMouseEvent {
	return {
		type,
		button,
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("InteractiveMode tab commands", () => {
	beforeEach(() => initTheme("dark"));

	it("matches tab by exact ID, 1-based index, and case-insensitive name", () => {
		const tab1 = createMockTab("tab-1", "First Tab");
		const tab2 = createMockTab("tab-2", "Second Tab");
		const tabs = [tab1, tab2];

		const context = {
			tabManager: {
				getAllTabs: () => tabs,
			},
		} as unknown as InteractiveModeTabContext;

		// Exact ID
		expect(prototype.findTabBySpec.call(context, "tab-1")).toBe(tab1);
		expect(prototype.findTabBySpec.call(context, "tab-2")).toBe(tab2);

		// 1-based index
		expect(prototype.findTabBySpec.call(context, "1")).toBe(tab1);
		expect(prototype.findTabBySpec.call(context, "2")).toBe(tab2);
		expect(prototype.findTabBySpec.call(context, "3")).toBeUndefined();

		// Name (case-insensitive)
		expect(prototype.findTabBySpec.call(context, "first tab")).toBe(tab1);
		expect(prototype.findTabBySpec.call(context, "SECOND TAB")).toBe(tab2);
		expect(prototype.findTabBySpec.call(context, "unknown")).toBeUndefined();
	});

	it("handles /tab list rendering tabs to chat container", async () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const tab2 = createMockTab("tab-2", "Tab 2");
		const tabs = [tab1, tab2];

		const chatContainer = new Container();
		const requestRender = vi.fn();

		const context = {
			tabManager: {
				getAllTabs: () => tabs,
				getActiveTab: () => tab1,
			},
			chatContainer,
			outputPad: 0,
			ui: { requestRender },
		} as unknown as InteractiveModeTabContext;

		await prototype.handleTabCommand.call(context, "/tab list");

		expect(requestRender).toHaveBeenCalled();
		const rendered = chatContainer.render(80).join("\n");
		expect(rendered).toContain("Tab 1");
		expect(rendered).toContain("Tab 2");
	});

	it("dispatches /tab new and /tab close", async () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const addTab = vi.fn(async () => tab1);
		const closeTab = vi.fn(async () => {});
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context = {
			tabManager: {
				getAllTabs: () => [tab1],
				getActiveTab: () => tab1,
			},
			sessionManager: {
				getCwd: () => "/work/dir",
			},
			addTab,
			closeTab,
			showStatus,
			showError,
			findTabBySpec: prototype.findTabBySpec,
		} as unknown as InteractiveModeTabContext;

		await prototype.handleTabCommand.call(context, "/tab new");
		expect(addTab).toHaveBeenCalledWith(undefined, undefined);

		await prototype.handleTabCommand.call(context, "/tab close");
		expect(closeTab).toHaveBeenCalledWith("tab-1");
	});

	it("dispatches /tab next and /tab prev", async () => {
		const switchNextTab = vi.fn(async () => {});
		const switchPrevTab = vi.fn(async () => {});

		const context = {
			switchNextTab,
			switchPrevTab,
		} as unknown as InteractiveModeTabContext;

		await prototype.handleTabCommand.call(context, "/tab next");
		expect(switchNextTab).toHaveBeenCalled();

		await prototype.handleTabCommand.call(context, "/tab prev");
		expect(switchPrevTab).toHaveBeenCalled();
	});

	it("dispatches /tab switch with spec and shorthand /tab <spec>", async () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const tab2 = createMockTab("tab-2", "Tab 2");
		const switchTab = vi.fn(async () => {});
		const showError = vi.fn();

		const context = {
			tabManager: {
				getAllTabs: () => [tab1, tab2],
			},
			switchTab,
			showError,
			findTabBySpec: prototype.findTabBySpec,
		} as unknown as InteractiveModeTabContext;

		// /tab switch 2
		await prototype.handleTabCommand.call(context, "/tab switch 2");
		expect(switchTab).toHaveBeenCalledWith("tab-2");

		// Shorthand /tab 1
		await prototype.handleTabCommand.call(context, "/tab 1");
		expect(switchTab).toHaveBeenCalledWith("tab-1");
	});

	it("verifies /new calls activeTabRuntime.newSession instead of addTab", async () => {
		const newSession = vi.fn(async () => ({ cancelled: false }));
		const chatContainer = new Container();
		const requestRender = vi.fn();
		const clearStatusIndicator = vi.fn();

		const context = {
			activeTabRuntime: { newSession },
			chatContainer,
			ui: { requestRender },
			clearStatusIndicator,
		} as unknown as InteractiveModeTabContext;

		await prototype.handleClearCommand.call(context);

		expect(newSession).toHaveBeenCalled();
		expect(clearStatusIndicator).toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalled();
	});

	it("dispatches /tab rename to active tab or specified tab", async () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const tab2 = createMockTab("tab-2", "Tab 2");
		const renameTab = vi.fn((_id, _name) => true);
		const refreshTabBar = vi.fn();
		const updateTerminalTitle = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();

		const context = {
			tabManager: {
				getAllTabs: () => [tab1, tab2],
				getActiveTab: () => tab1,
				renameTab,
			},
			refreshTabBar,
			updateTerminalTitle,
			showStatus,
			showError,
			ui: { requestRender },
			findTabBySpec: prototype.findTabBySpec,
		} as unknown as InteractiveModeTabContext;

		// Rename active tab
		await prototype.handleTabCommand.call(context, "/tab rename FeatureX");
		expect(renameTab).toHaveBeenCalledWith("tab-1", "FeatureX");
		expect(refreshTabBar).toHaveBeenCalled();
		expect(updateTerminalTitle).toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Renamed tab to Tab 1");

		// Rename tab by spec
		await prototype.handleTabCommand.call(context, "/tab rename 2 OtherFeature");
		expect(renameTab).toHaveBeenCalledWith("tab-2", "OtherFeature");

		// Invalid usage
		await prototype.handleTabCommand.call(context, "/tab rename");
		expect(showError).toHaveBeenCalledWith("Usage: /tab rename [spec] <name>");
	});
});

describe("TabBar component mouse interactions and rendering", () => {
	it("renders active tab with inverse styling, in-flight indicator, and buttons", () => {
		const tab1 = createMockTab("tab-1", "Tab 1", "/cwd", true); // streaming
		const tab2 = createMockTab("tab-2", "Tab 2", "/cwd", false);
		const onSwitch = vi.fn();
		const onAdd = vi.fn();
		const onClose = vi.fn();

		const tabBar = new TabBar({
			tabs: [tab1, tab2],
			activeId: "tab-1",
			onSwitch,
			onAdd,
			onClose,
		});

		const rendered = tabBar.render(80)[0] ?? "";
		// Active tab highlighted
		expect(rendered).toContain("\x1b[7m * Tab 1 \x1b[27m");
		// Inactive tab present
		expect(rendered).toContain("Tab 2");
		// Close button present for inactive tab
		expect(rendered).toContain("x");
		// Add button present
		expect(rendered).toContain("+");
	});

	it("does not render close button when only one tab exists", () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const tabBar = new TabBar({
			tabs: [tab1],
			activeId: "tab-1",
			onSwitch: vi.fn(),
			onAdd: vi.fn(),
			onClose: vi.fn(),
		});

		const rendered = tabBar.render(80)[0] ?? "";
		expect(rendered).not.toContain("x");
		expect(rendered).toContain("+");
	});

	it("handles mouse clicks to switch, close, and add tabs", () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const tab2 = createMockTab("tab-2", "Tab 2");
		const onSwitch = vi.fn();
		const onAdd = vi.fn();
		const onClose = vi.fn();

		const tabBar = new TabBar({
			tabs: [tab1, tab2],
			activeId: "tab-1",
			onSwitch,
			onAdd,
			onClose,
		});

		// Render to populate button regions
		tabBar.render(80);

		// Click on Tab 1 (around x = 2)
		const resTab1 = tabBar.handleMouse(makeMouseEvent("click", 2));
		expect(resTab1?.handled).toBe(true);
		expect(onSwitch).toHaveBeenCalledWith("tab-1");

		// Click on Tab 2 (Tab 1 is " Tab 1 " = 7 chars + 1 separator = 8, Tab 2 starts at 8)
		const resTab2 = tabBar.handleMouse(makeMouseEvent("click", 10));
		expect(resTab2?.handled).toBe(true);
		expect(onSwitch).toHaveBeenCalledWith("tab-2");

		// Click on Close button for Tab 2 (Tab 2 label ends at 15, close button " x " is 15-18)
		const resClose = tabBar.handleMouse(makeMouseEvent("click", 16));
		expect(resClose?.handled).toBe(true);
		expect(onClose).toHaveBeenCalledWith("tab-2");

		// Click on Add button "+" (after separator at 19, "+" is 19-22)
		const resAdd = tabBar.handleMouse(makeMouseEvent("click", 20));
		expect(resAdd?.handled).toBe(true);
		expect(onAdd).toHaveBeenCalled();
	});

	it("claims mouse press gesture without firing click actions", () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const onSwitch = vi.fn();
		const tabBar = new TabBar({
			tabs: [tab1],
			activeId: "tab-1",
			onSwitch,
			onAdd: vi.fn(),
			onClose: vi.fn(),
		});
		tabBar.render(80);

		const resPress = tabBar.handleMouse(makeMouseEvent("press", 2));
		expect(resPress?.handled).toBe(true);
		expect(onSwitch).not.toHaveBeenCalled();
	});

	it("returns undefined for mouse events outside bounds or non-zero row", () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const tabBar = new TabBar({
			tabs: [tab1],
			activeId: "tab-1",
			onSwitch: vi.fn(),
			onAdd: vi.fn(),
			onClose: vi.fn(),
		});
		tabBar.render(80);

		// Out of bounds on X
		expect(tabBar.handleMouse(makeMouseEvent("click", 75))).toBeUndefined();
		// Out of bounds on Y
		expect(tabBar.handleMouse(makeMouseEvent("click", 2, 1))).toBeUndefined();
	});

	it("truncates long tab names to 15 characters with ellipsis when idle", () => {
		const longTab = createMockTab("tab-1", "extremely-long-feature-branch-name");
		const shortTab = createMockTab("tab-2", "short-name");
		const tabBar = new TabBar({
			tabs: [longTab, shortTab],
			activeId: "tab-1",
			onSwitch: vi.fn(),
			onAdd: vi.fn(),
			onClose: vi.fn(),
		});

		const rendered = tabBar.render(80)[0] ?? "";
		// Long tab name is truncated to 15 characters (12 chars + ...)
		expect(rendered).toContain("extremely-lo...");
		// Short tab name is not truncated
		expect(rendered).toContain("short-name");
	});

	it("claims right-click press and fires onRename on right-click", () => {
		const tab1 = createMockTab("tab-1", "Tab 1");
		const onSwitch = vi.fn();
		const onRename = vi.fn();
		const tabBar = new TabBar({
			tabs: [tab1],
			activeId: "tab-1",
			onSwitch,
			onAdd: vi.fn(),
			onClose: vi.fn(),
			onRename,
		});
		tabBar.render(80);

		// Right press claims gesture without firing rename or switch
		const resPress = tabBar.handleMouse(makeMouseEvent("press", 2, 0, "right"));
		expect(resPress?.handled).toBe(true);
		expect(onRename).not.toHaveBeenCalled();
		expect(onSwitch).not.toHaveBeenCalled();

		// Right click on tab triggers onRename
		const resClick = tabBar.handleMouse(makeMouseEvent("click", 2, 0, "right"));
		expect(resClick?.handled).toBe(true);
		expect(onRename).toHaveBeenCalledWith("tab-1");
		expect(onSwitch).not.toHaveBeenCalled();
	});

	it("slides truncated tab name on hover and resets on mouse leave", () => {
		vi.useFakeTimers();
		try {
			const longTab = createMockTab("tab-1", "0123456789abcdefghij"); // 20 chars
			const requestRender = vi.fn();
			const tabBar = new TabBar({
				tabs: [longTab],
				activeId: "tab-1",
				onSwitch: vi.fn(),
				onAdd: vi.fn(),
				onClose: vi.fn(),
				requestRender,
			});

			// Initial idle render shows 15-char truncated name
			const initialRender = tabBar.render(80)[0] ?? "";
			expect(initialRender).toContain("0123456789ab...");

			// Mouse move onto tab activates hover
			const resMove = tabBar.handleMouse(makeMouseEvent("move", 2, 0, "none"));
			expect(resMove?.handled).toBe(true);
			expect(resMove?.render).toBe(true);

			// First hover frame starts at offset 0 (first 15 chars)
			const frame0 = tabBar.render(80)[0] ?? "";
			expect(frame0).toContain("0123456789abcde");

			// Advance timer by 140ms (1 tick) -> offset 1
			vi.advanceTimersByTime(140);
			expect(requestRender).toHaveBeenCalled();
			const frame1 = tabBar.render(80)[0] ?? "";
			expect(frame1).toContain("123456789abcdef");

			// Advance by another tick -> offset 2
			vi.advanceTimersByTime(140);
			const frame2 = tabBar.render(80)[0] ?? "";
			expect(frame2).toContain("23456789abcdefg");

			// Mouse moves off the tab (y !== 0) resets hover
			const resLeave = tabBar.handleMouse(makeMouseEvent("move", 2, 1, "none"));
			expect(resLeave?.handled).toBe(true);
			expect(resLeave?.render).toBe(true);

			// Render after leave returns to idle truncation
			const afterLeave = tabBar.render(80)[0] ?? "";
			expect(afterLeave).toContain("0123456789ab...");

			tabBar.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears hover slide when TUI input listener reports mouse outside row 0", () => {
		let registeredListener: ((data: string) => any) | undefined;
		const addInputListener = vi.fn((listener) => {
			registeredListener = listener;
			return () => {
				registeredListener = undefined;
			};
		});
		const requestRender = vi.fn();
		const longTab = createMockTab("tab-1", "0123456789abcdefghij");
		const tabBar = new TabBar({
			tabs: [longTab],
			activeId: "tab-1",
			onSwitch: vi.fn(),
			onAdd: vi.fn(),
			onClose: vi.fn(),
			requestRender,
			addInputListener,
		});

		tabBar.render(80);
		// Hover on tab
		tabBar.handleMouse(makeMouseEvent("move", 2, 0, "none"));

		expect(registeredListener).toBeDefined();
		// Simulate mouse move at row 2 (y=1 in SGR coordinates 1-based row 2)
		registeredListener!("\x1b[<35;5;2M");
		expect(requestRender).toHaveBeenCalled();

		// Should be reset to idle display
		const rendered = tabBar.render(80)[0] ?? "";
		expect(rendered).toContain("0123456789ab...");

		tabBar.dispose();
		expect(registeredListener).toBeUndefined();
	});
});

describe("createChatViewport layout with tabBar", () => {
	it("places tabBar at root VStack index 0 when provided", () => {
		const tabBar = new Container();
		const document = new Container();
		const pendingMessages = new Container();
		const status = new Container();
		const editor = new Container();
		const footer = new Container();

		const viewport = createChatViewport({
			tabBar,
			document,
			pendingMessages,
			status,
			editor,
			footer,
		});

		expect(viewport.root).toBeInstanceOf(VStack);
		const vstack = viewport.root as VStack;
		const entries = (vstack as any).entries;
		expect(entries[0].component).toBe(tabBar);
		expect(entries[1].component).toBe(viewport.transcript);
	});
});

describe("InteractiveMode auto-retry across tabs", () => {
	beforeEach(() => initTheme("dark"));

	type RetryContext = {
		context: InteractiveModeTabContext;
		tabs: TabSlot[];
		holders: Array<{ session: unknown }>;
		mainEscape: () => void;
		showStatusIndicator: ReturnType<typeof vi.fn>;
		session: (index: number) => { abortRetry: ReturnType<typeof vi.fn> };
	};

	/** A two-tab mode context whose active tab and tab list can be switched. */
	function createRetryContext(): RetryContext {
		const holders = [
			{ session: { abortRetry: vi.fn(), subscribe: vi.fn(() => () => {}) } },
			{ session: { abortRetry: vi.fn(), subscribe: vi.fn(() => () => {}) } },
		];
		const createTab = (id: string, name: string, cwd: string, holder: { session: unknown }) => {
			const tab = {
				id,
				name,
				cwd,
				runtime: {
					setBeforeSessionInvalidate: vi.fn(),
					setRebindSession: vi.fn(),
					dispose: vi.fn(async () => {}),
				},
			};
			// A tab's session follows its runtime, as TabSlot does in production.
			Object.defineProperty(tab, "session", { get: () => holder.session, enumerable: true });
			return tab as unknown as TabSlot;
		};
		const tabs = [
			createTab("tab-1", "Tab 1", "/work/a", holders[0]),
			createTab("tab-2", "Tab 2", "/work/b", holders[1]),
		];
		const active = { id: "tab-1" };
		const mainEscape = vi.fn();
		const showStatusIndicator = vi.fn();

		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			retryUiByTab: new Map<string, TabRetryUiStateFixture>(),
			tabState: { load: () => undefined, save: vi.fn() },
			workspaceKey: "/work/a",
			options: {},
			tabManager: {
				getAllTabs: () => tabs,
				getActiveTab: () => tabs.find((tab) => tab.id === active.id),
				snapshot: () => ({ tabs: [], activeIndex: 0 }),
				switchTab: async (id: string) => {
					active.id = id;
					return true;
				},
				removeTab: async (id: string) => {
					const index = tabs.findIndex((tab) => tab.id === id);
					if (index === -1) return false;
					tabs.splice(index, 1);
					if (active.id === id) active.id = tabs[0]?.id ?? "";
					return true;
				},
				getTab: (id: string) => tabs.find((tab) => tab.id === id),
				renameTab: () => true,
			},
			defaultEditor: { onEscape: mainEscape as (() => void) | undefined },
			pendingTools: new Map(),
			footer: { invalidate: () => {} },
			programStatus: { handleEvent: () => {}, reset: () => {} },
			ui: { requestRender: () => {} },
			statusContainer: new Container(),
			activeWorkingIndicatorEmbedded: false,
			setEditorWorkingStatusIndicator: () => false,
			showStatusIndicator: (indicator: StatusIndicatorFixture) => {
				showStatusIndicator(indicator);
				context.activeStatusIndicator = indicator;
			},
			clearStatusIndicator: (kind?: string) => {
				if (kind && context.activeStatusIndicator?.kind !== kind) return;
				context.activeStatusIndicator = undefined;
			},
			showError: vi.fn(),
			refreshTabBar: vi.fn(),
			updateTerminalTitle: vi.fn(),
			rebindCurrentSession: vi.fn(async () => {}),
			themeController: { applyFromSettings: vi.fn() },
		}) as unknown as InteractiveModeTabContext;
		context.activeStatusIndicator = undefined;

		const session = (index: number) =>
			holders[index].session as unknown as {
				abortRetry: ReturnType<typeof vi.fn>;
			};
		return { context, tabs, holders, mainEscape, showStatusIndicator, session };
	}

	const retryStart = (attempt = 1) => ({
		type: "auto_retry_start",
		attempt,
		maxAttempts: 3,
		delayMs: 10,
		errorMessage: "overloaded_error",
	});

	it("keeps Escape on the tab whose retry started and restores it on switch", async () => {
		const { context, tabs, mainEscape, session } = createRetryContext();

		await prototype.handleEvent.call(context, retryStart(), tabs[0]);
		const retryEscape = context.defaultEditor.onEscape;
		expect(retryEscape).toBeDefined();
		expect(retryEscape).not.toBe(mainEscape);

		retryEscape?.();
		expect(session(0).abortRetry).toHaveBeenCalledTimes(1);

		await prototype.switchTab.call(context, "tab-2");
		expect(context.defaultEditor.onEscape).toBe(mainEscape);
		expect(context.activeStatusIndicator).toBeUndefined();

		context.defaultEditor.onEscape?.();
		expect(session(0).abortRetry).toHaveBeenCalledTimes(1);
		expect(session(1).abortRetry).not.toHaveBeenCalled();
	});

	it("restores the tab's indicator and Escape when switching back to a retrying tab", async () => {
		const { context, tabs, mainEscape, session } = createRetryContext();

		await prototype.handleEvent.call(context, retryStart(), tabs[0]);
		await prototype.switchTab.call(context, "tab-2");
		await prototype.switchTab.call(context, "tab-1");

		expect(session(0).abortRetry).not.toHaveBeenCalled();
		expect(context.defaultEditor.onEscape).not.toBe(mainEscape);
		context.defaultEditor.onEscape?.();
		expect(session(0).abortRetry).toHaveBeenCalledTimes(1);

		await prototype.handleEvent.call(context, { type: "auto_retry_end", success: true, attempt: 1 }, tabs[0]);
		expect(context.defaultEditor.onEscape).toBe(mainEscape);
		expect(context.retryUiByTab.size).toBe(0);
	});

	it("does not save a retry closure as the main Escape on the next attempt", async () => {
		const { context, tabs, mainEscape, session } = createRetryContext();

		await prototype.handleEvent.call(context, retryStart(1), tabs[0]);
		const firstRetryEscape = context.defaultEditor.onEscape;
		await prototype.handleEvent.call(context, { type: "agent_start" }, tabs[0]);
		expect(context.defaultEditor.onEscape).toBe(mainEscape);
		// The attempt is running, so nothing is left to cancel.
		expect(context.retryUiByTab.size).toBe(0);
		expect(context.activeStatusIndicator).toBeUndefined();

		await prototype.handleEvent.call(context, retryStart(2), tabs[0]);
		const secondRetryEscape = context.defaultEditor.onEscape;
		expect(secondRetryEscape).not.toBe(mainEscape);
		expect(secondRetryEscape).not.toBe(firstRetryEscape);

		await prototype.handleEvent.call(context, { type: "auto_retry_end", success: false, attempt: 2 }, tabs[0]);
		expect(context.defaultEditor.onEscape).toBe(mainEscape);
		expect(session(0).abortRetry).not.toHaveBeenCalled();
	});

	it("shows a background tab's retry only when that tab becomes active", async () => {
		const { context, tabs, showStatusIndicator, session } = createRetryContext();
		prototype.setupTabListeners.call(context, tabs[1]);
		const listener = (tabs[1].session as unknown as { subscribe: { mock: { calls: unknown[][] } } }).subscribe.mock
			.calls[0][0] as (event: unknown) => Promise<void>;

		await listener(retryStart());
		expect(showStatusIndicator).not.toHaveBeenCalled();
		// Parked, not mounted: no animated indicator runs for a hidden tab.
		expect(context.retryUiByTab.get("tab-2")?.indicator).toBeUndefined();
		expect(context.retryUiByTab.get("tab-2")?.pendingRetry).toMatchObject({ attempt: 1, maxAttempts: 3 });

		await prototype.switchTab.call(context, "tab-2");
		expect(showStatusIndicator).toHaveBeenCalledTimes(1);
		expect(showStatusIndicator.mock.calls[0][0]).toMatchObject({ kind: "retry" });
		context.defaultEditor.onEscape?.();
		expect(session(1).abortRetry).toHaveBeenCalledTimes(1);

		await prototype.handleEvent.call(context, { type: "auto_retry_end", success: true, attempt: 1 }, tabs[1]);
		expect(context.retryUiByTab.size).toBe(0);
		expect(context.activeStatusIndicator).toBeUndefined();
	});

	it("clears a background tab's retry without mounting it", async () => {
		const { context, tabs, showStatusIndicator } = createRetryContext();
		prototype.setupTabListeners.call(context, tabs[1]);
		const listener = (tabs[1].session as unknown as { subscribe: { mock: { calls: unknown[][] } } }).subscribe.mock
			.calls[0][0] as (event: unknown) => Promise<void>;

		await listener(retryStart());
		await listener({ type: "auto_retry_end", success: false, attempt: 1, finalError: "overloaded_error" });

		expect(context.retryUiByTab.size).toBe(0);
		expect(showStatusIndicator).not.toHaveBeenCalled();
		await prototype.switchTab.call(context, "tab-2");
		expect(showStatusIndicator).not.toHaveBeenCalled();
	});

	it("drops a closed tab's retry state and gives Escape back", async () => {
		const { context, tabs, mainEscape } = createRetryContext();

		await prototype.handleEvent.call(context, retryStart(), tabs[0]);
		expect(context.defaultEditor.onEscape).not.toBe(mainEscape);

		await prototype.closeTab.call(context, "tab-1");
		expect(context.defaultEditor.onEscape).toBe(mainEscape);
		expect(context.retryUiByTab.size).toBe(0);
		expect(context.activeStatusIndicator).toBeUndefined();
	});

	it("re-attaches tab listeners to a tab's replacement session", async () => {
		const { context, tabs, holders } = createRetryContext();
		prototype.configureTabRuntime.call(context, tabs[0].runtime, "tab-1");
		const setRebindSession = (tabs[0].runtime as unknown as { setRebindSession: ReturnType<typeof vi.fn> })
			.setRebindSession;
		const rebind = setRebindSession.mock.calls[0][0] as (session: unknown) => Promise<void>;

		const replacement = {
			autoNameFirstTurn: false,
			subscribe: vi.fn(() => () => {}),
			sessionManager: { getSessionName: () => "replacement" },
		};
		holders[0].session = replacement;
		await rebind(replacement);

		expect(replacement.subscribe).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode tab state persistence", () => {
	beforeEach(() => initTheme("dark"));

	function savedWorkspace(overrides?: Partial<PersistedWorkspaceFixture>): PersistedWorkspaceFixture {
		return {
			tabs: [
				{ name: "Tab 1", customName: false, cwd: "/work/a", sessionFile: "/sessions/a.jsonl" },
				{ name: "Docs", customName: true, cwd: "/work/b", sessionFile: null },
			],
			activeIndex: 0,
			updatedAt: "2026-11-10T00:00:00.000Z",
			...overrides,
		};
	}

	function createPersistenceContext(options: {
		saved?: PersistedWorkspaceFixture;
		restoreTabs?: boolean;
		cwds: string[];
		addTabError?: string;
		persisted?: boolean;
	}) {
		const tabs = options.cwds.map((cwd, index) =>
			createMockTab(`tab-${index + 1}`, `Tab ${index + 1}`, cwd, false, options.persisted ?? true),
		);
		const load = vi.fn(() => options.saved);
		const save = vi.fn();
		const snapshot = { tabs: [], activeIndex: 0 };
		const renameTab = vi.fn(() => true);
		let failed = false;
		const addTab = vi.fn(async (request: { cwd: string; name?: string; sessionFile?: string }) => {
			if (options.addTabError !== undefined && !failed) {
				failed = true;
				throw new Error(options.addTabError);
			}
			const slot = createMockTab(`tab-${tabs.length + 1}`, request.name ?? "Restored", request.cwd);
			tabs.push(slot);
			return slot;
		});
		const switchTab = vi.fn(async () => {});
		const showWarning = vi.fn();
		const setupTabListeners = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			options: { restoreTabs: options.restoreTabs },
			tabState: { load, save },
			workspaceKey: "/work/a",
			tabManager: {
				getAllTabs: () => tabs,
				getActiveTab: () => tabs[0],
				addTab,
				renameTab,
				snapshot: () => snapshot,
			},
			switchTab,
			showWarning,
			setupTabListeners,
			refreshTabBar: vi.fn(),
			ui: { requestRender: vi.fn() },
			isRestoringTabs: false,
		}) as InteractiveModeTabContext;
		return { context, load, save, addTab, switchTab, showWarning, renameTab, tabs };
	}

	it("does not read saved tabs unless the entry point opted in", async () => {
		const { context, load } = createPersistenceContext({ saved: savedWorkspace(), cwds: ["/work/a"] });
		await prototype.restoreTabState.call(context);
		expect(load).not.toHaveBeenCalled();
	});

	it("restores saved tabs after the first and activates the saved index", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-restore-"));
		try {
			await mkdir(join(root, "b"), { recursive: true });
			await mkdir(join(root, "c"), { recursive: true });
			const { context, addTab, switchTab, save, tabs } = createPersistenceContext({
				saved: savedWorkspace({
					tabs: [
						{ name: "Tab 1", customName: false, cwd: root, sessionFile: null },
						{ name: "Docs", customName: true, cwd: join(root, "b"), sessionFile: "/sessions/b.jsonl" },
						{ name: "Notes", customName: true, cwd: join(root, "c"), sessionFile: null },
					],
					activeIndex: 2,
				}),
				restoreTabs: true,
				cwds: [root],
			});

			await prototype.restoreTabState.call(context);

			expect(addTab).toHaveBeenCalledTimes(2);
			expect(addTab).toHaveBeenNthCalledWith(1, {
				cwd: join(root, "b"),
				name: "Docs",
				sessionFile: "/sessions/b.jsonl",
			});
			expect(addTab).toHaveBeenNthCalledWith(2, {
				cwd: join(root, "c"),
				name: "Notes",
				sessionFile: undefined,
			});
			expect(switchTab).toHaveBeenCalledWith(tabs[2].id);
			expect(save).toHaveBeenCalledTimes(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("renames the first tab to the saved name", async () => {
		const { context, renameTab, tabs } = createPersistenceContext({
			saved: savedWorkspace({
				tabs: [{ name: "Work", customName: true, cwd: "/work/a", sessionFile: null }],
				activeIndex: 0,
			}),
			restoreTabs: true,
			cwds: ["/work/a"],
		});

		await prototype.restoreTabState.call(context);

		expect(renameTab).toHaveBeenCalledWith(tabs[0].id, "Work", true);
	});

	it("activates the saved tab even when an earlier one was skipped", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-restore-skip-"));
		try {
			await mkdir(join(root, "notes"), { recursive: true });
			const { context, switchTab, tabs } = createPersistenceContext({
				saved: savedWorkspace({
					tabs: [
						{ name: "Tab 1", customName: false, cwd: root, sessionFile: null },
						{ name: "Gone", customName: true, cwd: join(tmpdir(), "pi-tab-missing-skip"), sessionFile: null },
						{ name: "Notes", customName: true, cwd: join(root, "notes"), sessionFile: null },
					],
					activeIndex: 2,
				}),
				restoreTabs: true,
				cwds: [root],
			});

			await prototype.restoreTabState.call(context);

			expect(tabs).toHaveLength(2);
			expect(switchTab).toHaveBeenCalledWith(tabs[1].id);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("skips a saved tab whose cwd is gone and keeps the rest", async () => {
		const { context, addTab, save, showWarning } = createPersistenceContext({
			saved: savedWorkspace({
				tabs: [
					{ name: "Tab 1", customName: false, cwd: "/work/a", sessionFile: null },
					{ name: "Gone", customName: true, cwd: join(tmpdir(), "pi-tab-missing-dir"), sessionFile: null },
				],
			}),
			restoreTabs: true,
			cwds: ["/work/a"],
		});
		await prototype.restoreTabState.call(context);
		expect(addTab).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("Gone"));
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps restoring when one saved tab fails to open", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-restore-fail-"));
		try {
			await mkdir(join(root, "b"), { recursive: true });
			await mkdir(join(root, "c"), { recursive: true });
			const { context, addTab, showWarning, save, tabs } = createPersistenceContext({
				saved: savedWorkspace({
					tabs: [
						{ name: "Tab 1", customName: false, cwd: root, sessionFile: null },
						{ name: "Broken", customName: true, cwd: join(root, "b"), sessionFile: null },
						{ name: "Notes", customName: true, cwd: join(root, "c"), sessionFile: null },
					],
				}),
				restoreTabs: true,
				cwds: [root],
				addTabError: "boom",
			});

			await prototype.restoreTabState.call(context);

			expect(addTab).toHaveBeenCalledTimes(2);
			expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("boom"));
			expect(tabs).toHaveLength(2);
			expect(save).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("saves the snapshot under the workspace key", () => {
		const { context, save } = createPersistenceContext({ cwds: ["/work/a"], restoreTabs: true });
		prototype.saveTabState.call(context);
		expect(save).toHaveBeenCalledWith("/work/a", { tabs: [], activeIndex: 0 });
	});

	it("does not save when the entry point did not opt in", () => {
		const { context, save } = createPersistenceContext({ cwds: ["/work/a"] });
		prototype.saveTabState.call(context);
		expect(save).not.toHaveBeenCalled();
	});

	it("does not save a non-persisted tab layout", () => {
		const { context, save } = createPersistenceContext({ cwds: ["/work/a"], restoreTabs: true, persisted: false });
		prototype.saveTabState.call(context);
		expect(save).not.toHaveBeenCalled();
	});

	it("does not save while a restore is still running", () => {
		const { context, save } = createPersistenceContext({ cwds: ["/work/a"], restoreTabs: true });
		context.isRestoringTabs = true;
		prototype.saveTabState.call(context);
		expect(save).not.toHaveBeenCalled();
	});

	it("warns instead of throwing when the layout cannot be saved", () => {
		const showWarning = vi.fn();
		const tab = createMockTab("tab-1", "Tab 1", "/work/a");
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			options: { restoreTabs: true },
			tabState: {
				load: () => undefined,
				save: () => {
					throw new Error("disk full");
				},
			},
			workspaceKey: "/work/a",
			tabManager: { getAllTabs: () => [tab], snapshot: () => ({ tabs: [], activeIndex: 0 }) },
			showWarning,
		}) as InteractiveModeTabContext;
		expect(() => prototype.saveTabState.call(context)).not.toThrow();
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("disk full"));
	});

	it("rebinds without rendering while a restore is in progress", async () => {
		const rebindCurrentSession = vi.fn(async () => {});
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			isRestoringTabs: true,
			tabManager: {
				getActiveTab: () => createMockTab("tab-2", "Tab 2"),
				switchTab: async () => true,
			},
			rebindCurrentSession,
			detachTabRetryUi: vi.fn(),
			attachTabRetryUi: vi.fn(),
			saveTabState: vi.fn(),
			refreshTabBar: vi.fn(),
			ui: { requestRender: vi.fn() },
		}) as unknown as InteractiveModeTabContext;

		await prototype.switchTab.call(context, "tab-2");
		expect(rebindCurrentSession).toHaveBeenCalledWith({ renderBeforeBind: false });

		// Outside a restore the same switch renders before binding, as before.
		context.isRestoringTabs = false;
		await prototype.switchTab.call(context, "tab-2");
		expect(rebindCurrentSession).toHaveBeenLastCalledWith({ renderBeforeBind: true });
	});
});

describe("InteractiveMode first tab restore", () => {
	beforeEach(() => initTheme("dark"));

	it("resumes the saved session in the tab the entry point created", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-first-tab-"));
		try {
			const sessionFile = join(root, "saved.jsonl");
			const switchSession = vi.fn(async () => ({ cancelled: false }));
			const context = Object.assign(Object.create(InteractiveMode.prototype), {
				tabManager: {
					getActiveTab: () => ({
						runtime: {
							switchSession,
							session: { sessionManager: { getSessionFile: () => join(root, "fresh.jsonl") } },
						},
					}),
				},
				createProjectTrustContext: () => undefined,
				showWarning: vi.fn(),
			}) as unknown as InteractiveModeTabContext;

			await writeFile(sessionFile, "", "utf-8");
			const resumed = await prototype.resumeFirstTabSession.call(context, {
				name: "Tab 1",
				customName: false,
				cwd: root,
				sessionFile,
			});

			expect(resumed).toBe(true);
			expect(switchSession).toHaveBeenCalledWith(sessionFile, expect.objectContaining({ cwdOverride: root }));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the new session when the saved one cannot resume", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-first-tab-fail-"));
		try {
			const sessionFile = join(root, "saved.jsonl");
			await writeFile(sessionFile, "", "utf-8");
			const showWarning = vi.fn();
			const context = Object.assign(Object.create(InteractiveMode.prototype), {
				tabManager: {
					getActiveTab: () => ({
						runtime: {
							switchSession: async () => {
								throw new Error("locked");
							},
							session: { sessionManager: { getSessionFile: () => undefined } },
						},
					}),
				},
				createProjectTrustContext: () => undefined,
				showWarning,
			}) as unknown as InteractiveModeTabContext;

			const resumed = await prototype.resumeFirstTabSession.call(context, {
				name: "Tab 1",
				customName: false,
				cwd: root,
				sessionFile,
			});

			expect(resumed).toBe(false);
			expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("locked"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
