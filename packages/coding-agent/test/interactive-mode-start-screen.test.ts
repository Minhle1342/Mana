import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { manaLogoLines } from "../src/modes/interactive/components/pi-logo.ts";
import { StartScreen } from "../src/modes/interactive/components/start-screen.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function mockEditor(
	lines: string[],
	handleMouse?: (event: TuiMouseEvent) => any,
	handleInput?: (data: string) => void,
): Component {
	return {
		render: () => lines,
		handleMouse,
		handleInput,
		invalidate: () => {},
	} as unknown as Component;
}

/** Footer stand-in; empty by default so logo/editor row assertions keep their layout. */
function mockFooter(lines: string[] = []): Component {
	return mockEditor(lines);
}

type StartScreenContext = {
	renderer?: { mode: string };
	chatContainer?: { children: unknown[] };
	tabManager: {
		getActiveTab: () =>
			| {
					session: {
						sessionManager?: { getEntryCount: () => number };
						messages?: unknown[];
						isStreaming: boolean;
					};
			  }
			| undefined;
	};
};

const proto = InteractiveMode.prototype as unknown as {
	isStartScreenVisible(this: StartScreenContext): boolean;
};

describe("StartScreen", () => {
	beforeEach(() => initTheme("dark"));

	it("renders a number of lines equal to the terminal height", () => {
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(),
			getHeight: () => 30,
		});
		const rendered = screen.render(80);
		expect(rendered).toHaveLength(30);
	});

	it("vertically centers the logo and editor within the terminal height", () => {
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(),
			getHeight: () => 30,
		});
		const rendered = screen.render(80);

		// 6 logo lines + 1 editor line = 7 content lines in 30 rows -> 11 top spacer rows.
		for (let i = 0; i < 11; i++) expect(rendered[i]).toBe(" ".repeat(80));
		// First logo line sits right after the top spacer, horizontally centered (20 cells each side).
		expect(rendered[11]).toContain("███╗");
		expect(rendered[11]).toBe(" ".repeat(20) + rendered[11]!.trim() + " ".repeat(20));
		// Editor line follows the logo.
		expect(rendered[17]).toContain(">");
		expect(rendered[29]).toBe(" ".repeat(80));
	});

	it("centers the editor line horizontally", () => {
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(),
			getHeight: () => 30,
		});
		const rendered = screen.render(80);
		// "> " is 2 cells wide, centered in 80 -> 39 spaces each side.
		expect(rendered[17]).toBe(`${" ".repeat(39)}> ${" ".repeat(39)}`);
	});

	it("renders the footer directly below the editor", () => {
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(["~/project (main)", "claude • thinking off"]),
			getHeight: () => 30,
		});
		const rendered = screen.render(80);
		expect(rendered).toHaveLength(30);
		// 6 logo + 1 editor + 2 footer rows = 9 content rows in 30 -> 10 top spacer rows.
		expect(rendered[9]).toBe(" ".repeat(80));
		expect(rendered[16]).toContain("> ");
		expect(rendered[17].startsWith("~/project (main)")).toBe(true);
		expect(rendered[18].startsWith("claude • thinking off")).toBe(true);
		// Footer spans the full width, like the dock footer.
		expect(rendered[17]).toHaveLength(80);
		expect(rendered[19]).toBe(" ".repeat(80));
	});

	it("counts footer rows when fitting the logo", () => {
		const footerLines = ["~/project", "claude", "ext-status"];
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(footerLines),
			getHeight: () => 12, // 6 logo + 1 editor + 3 footer + 2 = 12 fits exactly
		});
		expect(screen.render(80).some((line) => line.includes("███╗"))).toBe(true);

		// One row less drops to the wordmark instead of clipping the footer.
		const tight = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(footerLines),
			getHeight: () => 11,
		});
		const tightLines = tight.render(80);
		expect(tightLines.some((line) => line.includes("███╗"))).toBe(false);
		expect(tightLines.some((line) => line.includes("M") && line.includes("ana"))).toBe(true);
		expect(tightLines.some((line) => line.includes("ext-status"))).toBe(true);
	});

	it("forwards keyboard input to the editor via handleInput", () => {
		const handleInput = vi.fn();
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "], undefined, handleInput),
			footer: mockFooter(),
			getHeight: () => 30,
		});
		screen.handleInput("hello");
		expect(handleInput).toHaveBeenCalledWith("hello");
	});

	it("adjusts editor mouse click coordinates relative to editorLeft", () => {
		const handleMouse = vi.fn();
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "], handleMouse),
			footer: mockFooter(),
			getHeight: () => 30,
		});
		screen.render(80); // editorLeft is 39, editorTop is 17
		const event = {
			type: "click",
			button: "left",
			x: 41,
			y: 17,
			screenX: 41,
			screenY: 17,
			width: 80,
			height: 30,
			shift: false,
			alt: false,
			ctrl: false,
		} as TuiMouseEvent;
		screen.handleMouse(event);
		expect(handleMouse).toHaveBeenCalledWith(
			expect.objectContaining({
				x: 2, // 41 - 39
				y: 0, // 17 - 17
			}),
		);
	});

	it("falls back to the wordmark when the logo does not fit the width", () => {
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(),
			getHeight: () => 30,
			onLogoClick: vi.fn(),
		});
		const rendered = screen.render(20);
		expect(rendered.some((line) => line.includes("M") && line.includes("ana"))).toBe(true);
		expect(rendered.every((line) => visibleWidth(line) <= 20)).toBe(true);
	});

	it("reports logo clicks via onLogoClick", () => {
		const onLogoClick = vi.fn();
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: mockEditor(["> "]),
			footer: mockFooter(),
			getHeight: () => 30,
			onLogoClick,
		});
		screen.render(80);
		// First logo line row is 11, its left padding is 20.
		const event = {
			type: "click",
			button: "left",
			x: 25,
			y: 11,
			screenX: 25,
			screenY: 11,
			width: 80,
			height: 30,
			shift: false,
			alt: false,
			ctrl: false,
		} as TuiMouseEvent;
		screen.handleMouse(event);
		expect(onLogoClick).toHaveBeenCalledWith(25, 11);
	});

	it("renders selector content when editor is a Container holding a selector", () => {
		const container = new Container();
		container.addChild(mockEditor(["Select an option:", "  1. Model settings", "  2. Theme settings"]));
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: container,
			footer: mockFooter(),
			getHeight: () => 30,
		});
		const rendered = screen.render(80);
		expect(rendered.some((line) => line.includes("Select an option:"))).toBe(true);
		expect(rendered.some((line) => line.includes("1. Model settings"))).toBe(true);
		expect(rendered.some((line) => line.includes("2. Theme settings"))).toBe(true);
	});

	it("collapses logo to wordmark when vertical space is constrained by selector height", () => {
		const selectorLines = Array.from({ length: 15 }, (_, i) => `Selector item ${i + 1}`);
		const container = new Container();
		container.addChild(mockEditor(selectorLines));
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: container,
			footer: mockFooter(),
			getHeight: () => 20, // 20 rows: 6 (logo) + 15 (selector) = 21 > 20, cannot fit full logo
		});
		const rendered = screen.render(80);
		expect(rendered).toHaveLength(20);
		// Full block logo should NOT be rendered
		expect(rendered.some((line) => line.includes("███╗"))).toBe(false);
		// Wordmark should be rendered (1 + 15 = 16 <= 20)
		expect(rendered.some((line) => line.includes("M") && line.includes("ana"))).toBe(true);
		// All selector items must be visible
		for (let i = 1; i <= 15; i++) {
			expect(rendered.some((line) => line.includes(`Selector item ${i}`))).toBe(true);
		}
	});

	it("collapses logo completely when vertical space cannot fit wordmark and selector", () => {
		const selectorLines = Array.from({ length: 15 }, (_, i) => `Selector item ${i + 1}`);
		const container = new Container();
		container.addChild(mockEditor(selectorLines));
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: container,
			footer: mockFooter(),
			getHeight: () => 15, // exactly 15 rows for 15 selector lines
		});
		const rendered = screen.render(80);
		expect(rendered).toHaveLength(15);
		// Neither full logo nor wordmark
		expect(rendered.some((line) => line.includes("███╗"))).toBe(false);
		expect(rendered.some((line) => line.includes("Mana"))).toBe(false);
		// All selector items must be visible
		for (let i = 1; i <= 15; i++) {
			expect(rendered.some((line) => line.includes(`Selector item ${i}`))).toBe(true);
		}
	});

	it("forwards keyboard input to container children via handleInput", () => {
		const handleInput = vi.fn();
		const container = new Container();
		container.addChild(mockEditor(["> "], undefined, handleInput));
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: container,
			footer: mockFooter(),
			getHeight: () => 30,
		});
		screen.handleInput("/settings");
		expect(handleInput).toHaveBeenCalledWith("/settings");
	});

	it("forwards mouse clicks to container children in selector area", () => {
		const handleMouse = vi.fn();
		const container = new Container();
		container.addChild(mockEditor(["> "], handleMouse));
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: container,
			footer: mockFooter(),
			getHeight: () => 30,
		});
		screen.render(80);
		const event = {
			type: "click",
			button: "left",
			x: 41,
			y: 17,
			screenX: 41,
			screenY: 17,
			width: 80,
			height: 30,
			shift: false,
			alt: false,
			ctrl: false,
		} as TuiMouseEvent;
		screen.handleMouse(event);
		expect(handleMouse).toHaveBeenCalledWith(
			expect.objectContaining({
				x: 2,
				y: 0,
			}),
		);
	});

	it("binds startScreen editor to editorContainer so selector components display on start screen", () => {
		const container = new Container();
		const screen = new StartScreen({
			logoLines: manaLogoLines(),
			editor: container,
			footer: mockFooter(),
			getHeight: () => 30,
		});

		// Initially editorContainer contains default editor
		const defaultEditor = mockEditor(["> "]);
		container.addChild(defaultEditor);
		let rendered = screen.render(80);
		expect(rendered.some((l) => l.includes("> "))).toBe(true);

		// When a slash command opens a selector (e.g., /settings)
		// showSelector clears editorContainer and mounts the selector component:
		container.clear();
		const selector = mockEditor(["Settings", "  1. Model: anthropic/claude-3-5-sonnet", "  2. Theme: dark"]);
		container.addChild(selector);

		// StartScreen immediately renders the selector component
		rendered = screen.render(80);
		expect(rendered.some((l) => l.includes("Settings"))).toBe(true);
		expect(rendered.some((l) => l.includes("anthropic/claude-3-5-sonnet"))).toBe(true);
		expect(rendered.some((l) => l.includes("> "))).toBe(false);

		// When selector finishes/cancels, default editor is restored
		container.clear();
		container.addChild(defaultEditor);
		rendered = screen.render(80);
		expect(rendered.some((l) => l.includes("> "))).toBe(true);
		expect(rendered.some((l) => l.includes("Settings"))).toBe(false);
	});
});

describe("InteractiveMode.isStartScreenVisible", () => {
	it("shows the start screen for an empty, non-streaming session", () => {
		const ctx: StartScreenContext = {
			tabManager: {
				getActiveTab: () => ({
					session: { sessionManager: { getEntryCount: () => 0 }, isStreaming: false },
				}),
			},
		};
		expect(proto.isStartScreenVisible.call(ctx)).toBe(true);
	});

	it("shows the start screen when session has metadata entries but no messages", () => {
		const ctx: StartScreenContext = {
			tabManager: {
				getActiveTab: () => ({
					session: {
						messages: [],
						sessionManager: { getEntryCount: () => 2 },
						isStreaming: false,
					},
				}),
			},
		};
		expect(proto.isStartScreenVisible.call(ctx)).toBe(true);
	});

	it("hides the start screen when chatContainer has children (e.g. from /hotkeys or /changelog)", () => {
		const ctx: StartScreenContext = {
			chatContainer: { children: ["hotkeys-table"] },
			tabManager: {
				getActiveTab: () => ({
					session: { sessionManager: { getEntryCount: () => 0 }, messages: [], isStreaming: false },
				}),
			},
		};
		expect(proto.isStartScreenVisible.call(ctx)).toBe(false);
	});

	it("hides the start screen when not in fullscreen mode", () => {
		const ctx: StartScreenContext = {
			renderer: { mode: "regular" },
			tabManager: {
				getActiveTab: () => ({
					session: { sessionManager: { getEntryCount: () => 0 }, isStreaming: false },
				}),
			},
		};
		expect(proto.isStartScreenVisible.call(ctx)).toBe(false);
	});

	it("hides the start screen when the session has messages", () => {
		const ctx: StartScreenContext = {
			tabManager: {
				getActiveTab: () => ({
					session: { sessionManager: { getEntryCount: () => 3 }, isStreaming: false },
				}),
			},
		};
		expect(proto.isStartScreenVisible.call(ctx)).toBe(false);
	});

	it("hides the start screen while the active session is streaming", () => {
		const ctx: StartScreenContext = {
			tabManager: {
				getActiveTab: () => ({
					session: { sessionManager: { getEntryCount: () => 0 }, isStreaming: true },
				}),
			},
		};
		expect(proto.isStartScreenVisible.call(ctx)).toBe(false);
	});

	it("hides the start screen when there is no active tab", () => {
		const ctx: StartScreenContext = { tabManager: { getActiveTab: () => undefined } };
		expect(proto.isStartScreenVisible.call(ctx)).toBe(false);
	});

	it("initializes showStartScreen as undefined so initial sync always mounts layout", () => {
		const im = {
			showStartScreen: undefined as boolean | undefined,
			isStartScreenVisible: () => false,
			rebuildLayout() {
				rebuildCalled = true;
			},
			syncStartScreen: (InteractiveMode.prototype as any).syncStartScreen,
		};
		let rebuildCalled = false;
		im.syncStartScreen();
		expect(rebuildCalled).toBe(true);
		expect(im.showStartScreen).toBe(false);
	});

	it("transitions showStartScreen from true to false when chatContainer receives content from /hotkeys or /changelog", () => {
		const chatContainer = new Container();
		let rebuildCalled = false;
		const im = {
			showStartScreen: true as boolean | undefined,
			chatContainer,
			tabManager: {
				getActiveTab: () => ({
					session: { sessionManager: { getEntryCount: () => 0 }, messages: [], isStreaming: false },
				}),
			},
			isStartScreenVisible: (InteractiveMode.prototype as any).isStartScreenVisible,
			rebuildLayout() {
				rebuildCalled = true;
			},
			syncStartScreen: (InteractiveMode.prototype as any).syncStartScreen,
		};

		// When chatContainer has no children, isStartScreenVisible is true (no transition)
		im.syncStartScreen();
		expect(rebuildCalled).toBe(false);
		expect(im.showStartScreen).toBe(true);

		// When /hotkeys adds content to chatContainer:
		chatContainer.addChild(mockEditor(["Keyboard Shortcuts Table"]));
		im.syncStartScreen();
		expect(rebuildCalled).toBe(true);
		expect(im.showStartScreen).toBe(false);
	});
});
