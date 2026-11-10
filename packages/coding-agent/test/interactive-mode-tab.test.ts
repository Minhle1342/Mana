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
	handleClearCommand: () => Promise<void>;
	clearStatusIndicator: () => void;
	findTabBySpec: (spec: string) => TabSlot | undefined;
	handleTabCommand: (text: string) => Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModeTabContext;

function createMockTab(id: string, name: string, cwd = "/work/dir", isStreaming = false): TabSlot {
	return {
		id,
		name,
		cwd,
		session: {
			isStreaming,
			prompt: vi.fn(async () => {}),
		} as unknown as any,
		runtime: {
			cwd,
			session: {} as any,
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime,
	};
}

function makeMouseEvent(type: "click" | "press" | "move", x: number, y = 0): TuiMouseEvent {
	return {
		type,
		button: "left",
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
