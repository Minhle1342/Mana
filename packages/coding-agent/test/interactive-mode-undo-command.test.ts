import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function userEntry(id: string, content: string) {
	return { type: "message", id, message: { role: "user", content } };
}

function assistantEntry(id: string) {
	return { type: "message", id, message: { role: "assistant", content: [] } };
}

function createInstance(
	options: {
		branch?: unknown[];
		leafId?: string | null;
		isStreaming?: boolean;
		undoToCheckpoint?: ReturnType<typeof vi.fn>;
		revertUndo?: ReturnType<typeof vi.fn>;
		getRevertLeafId?: ReturnType<typeof vi.fn>;
		navigateTree?: ReturnType<typeof vi.fn>;
	} = {},
) {
	const undoToCheckpoint =
		options.undoToCheckpoint ?? vi.fn(async () => ({ revertId: "rev-1", revertAdded: 5, revertDeleted: 2 }));
	const revertUndo = options.revertUndo ?? vi.fn(async () => ({ success: true }));
	const getRevertLeafId = options.getRevertLeafId ?? vi.fn(() => undefined);
	const navigateTree = options.navigateTree ?? vi.fn(async () => ({ cancelled: false }));
	const setText = vi.fn();
	const clear = vi.fn();
	const renderInitialMessages = vi.fn();
	const showStyledStatus = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const showWarning = vi.fn();
	const clearStatusIndicator = vi.fn();

	const instance = Object.create(InteractiveMode.prototype);
	instance.runtimeHost = {
		session: {
			sessionManager: {
				getBranch: () => options.branch ?? [],
				getLeafId: () => options.leafId ?? null,
			},
			isStreaming: options.isStreaming ?? false,
			isCompacting: false,
			isBashRunning: false,
			navigateTree,
			checkpointManager: { undoToCheckpoint, revertUndo, getRevertLeafId },
		},
	};
	instance.defaultEditor = {};
	instance.editor = { setText, getText: () => "" };
	instance.chatContainer = { clear };
	instance.renderInitialMessages = renderInitialMessages;
	instance.showStyledStatus = showStyledStatus;
	instance.showStatus = showStatus;
	instance.showError = showError;
	instance.showWarning = showWarning;
	instance.clearStatusIndicator = clearStatusIndicator;
	instance.setupEditorSubmitHandler();

	return {
		instance,
		undoToCheckpoint,
		revertUndo,
		getRevertLeafId,
		navigateTree,
		setText,
		clear,
		renderInitialMessages,
		showStyledStatus,
		showStatus,
		showError,
		showWarning,
		clearStatusIndicator,
	};
}

describe("InteractiveMode /undo and /revert commands", () => {
	it("registers /undo and /revert in BUILTIN_SLASH_COMMANDS", () => {
		const undoCmd = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === "undo");
		expect(undoCmd).toBeDefined();
		expect(undoCmd?.description.toLowerCase()).toContain("checkpoint");

		const revertCmd = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === "revert");
		expect(revertCmd).toBeDefined();
		expect(revertCmd?.description.toLowerCase()).toContain("revert");
	});

	it("rewinds the conversation, refills the editor, and shows the rewind status on /undo", async () => {
		const branch = [userEntry("u1", "one"), assistantEntry("a1"), userEntry("u2", "two")];
		const fakes = createInstance({
			branch,
			leafId: "leaf-1",
			navigateTree: vi.fn(async () => ({ cancelled: false, editorText: "two" })),
		});

		await fakes.instance.defaultEditor.onSubmit("/undo");

		expect(fakes.undoToCheckpoint).toHaveBeenCalledWith(2, "leaf-1");
		expect(fakes.navigateTree).toHaveBeenCalledWith("u2", { summarize: false });
		expect(fakes.clear).toHaveBeenCalledTimes(1);
		expect(fakes.renderInitialMessages).toHaveBeenCalledTimes(1);
		expect(fakes.setText).toHaveBeenNthCalledWith(1, "");
		expect(fakes.setText).toHaveBeenLastCalledWith("two");
		initTheme("dark");
		const message = fakes.showStyledStatus.mock.calls[0]?.[0]();
		expect(stripAnsi(message)).toBe(
			"Undid checkpoint (+2 restored, -5 removed) and moved the conversation back. Use /revert to restore.",
		);
		expect(message).toContain(theme.fg("toolDiffAdded", "+2 restored"));
		expect(message).toContain(theme.fg("toolDiffRemoved", "-5 removed"));
		expect(fakes.showError).not.toHaveBeenCalled();
		expect(fakes.showWarning).not.toHaveBeenCalled();
	});

	it("rewinds to the user turn named on /undo", async () => {
		const branch = [userEntry("u1", "one"), assistantEntry("a1"), userEntry("u2", "two"), userEntry("u3", "three")];
		const fakes = createInstance({
			branch,
			leafId: "leaf-3",
			navigateTree: vi.fn(async () => ({ cancelled: false, editorText: "two" })),
		});

		await fakes.instance.defaultEditor.onSubmit("/undo 2");

		expect(fakes.undoToCheckpoint).toHaveBeenCalledWith(2, "leaf-3");
		expect(fakes.navigateTree).toHaveBeenCalledWith("u2", { summarize: false });
		expect(fakes.setText).toHaveBeenLastCalledWith("two");
	});

	it("warns without undoing when the turn is not on the branch", async () => {
		const fakes = createInstance({ branch: [userEntry("u1", "one")] });

		await fakes.instance.defaultEditor.onSubmit("/undo 9");

		expect(fakes.showWarning).toHaveBeenCalledWith("No user message found for turn 9.");
		expect(fakes.undoToCheckpoint).not.toHaveBeenCalled();
		expect(fakes.navigateTree).not.toHaveBeenCalled();
		expect(fakes.setText).toHaveBeenCalledWith("");
	});

	it("warns without undoing when the branch has no user turn", async () => {
		const fakes = createInstance({ branch: [] });

		await fakes.instance.defaultEditor.onSubmit("/undo");

		expect(fakes.showWarning).toHaveBeenCalledWith("No user turn to undo.");
		expect(fakes.undoToCheckpoint).not.toHaveBeenCalled();
		expect(fakes.navigateTree).not.toHaveBeenCalled();
	});

	it("keeps the file undo and warns when the rewind is cancelled", async () => {
		const fakes = createInstance({
			branch: [userEntry("u1", "one")],
			leafId: "leaf-1",
			navigateTree: vi.fn(async () => ({ cancelled: true })),
		});

		await fakes.instance.defaultEditor.onSubmit("/undo");

		expect(fakes.undoToCheckpoint).toHaveBeenCalledWith(1, "leaf-1");
		expect(fakes.showWarning).toHaveBeenCalledWith(
			"Undid checkpoint (+2 restored, -5 removed) but the conversation was not moved back. Use /revert to restore.",
		);
		expect(fakes.showStyledStatus).not.toHaveBeenCalled();
		expect(fakes.clear).not.toHaveBeenCalled();
		expect(fakes.renderInitialMessages).not.toHaveBeenCalled();
	});

	it("keeps the file undo and warns when the rewind throws", async () => {
		const fakes = createInstance({
			branch: [userEntry("u1", "one")],
			leafId: "leaf-1",
			navigateTree: vi.fn(async () => {
				throw new Error("navigation blocked");
			}),
		});

		await fakes.instance.defaultEditor.onSubmit("/undo");

		expect(fakes.showWarning).toHaveBeenCalledWith(
			"Undid checkpoint (+2 restored, -5 removed) but rewinding the conversation failed: navigation blocked. Use /revert to restore.",
		);
		expect(fakes.showStyledStatus).not.toHaveBeenCalled();
		expect(fakes.renderInitialMessages).not.toHaveBeenCalled();
	});

	it("rejects /undo while agent is streaming", async () => {
		const fakes = createInstance({ branch: [userEntry("u1", "one")], isStreaming: true });

		await fakes.instance.defaultEditor.onSubmit("/undo");

		expect(fakes.setText).toHaveBeenCalledWith("");
		expect(fakes.undoToCheckpoint).not.toHaveBeenCalled();
		expect(fakes.showWarning).toHaveBeenCalledWith("Wait for the current response to finish before undoing.");
	});

	it("moves the conversation forward and shows the redo status on /revert", async () => {
		const fakes = createInstance({
			getRevertLeafId: vi.fn(() => "leaf-9"),
			navigateTree: vi.fn(async () => ({ cancelled: false })),
		});

		await fakes.instance.defaultEditor.onSubmit("/revert");

		expect(fakes.getRevertLeafId).toHaveBeenCalledTimes(1);
		expect(fakes.revertUndo).toHaveBeenCalledTimes(1);
		expect(fakes.navigateTree).toHaveBeenCalledWith("leaf-9", { summarize: false });
		expect(fakes.clear).toHaveBeenCalledTimes(1);
		expect(fakes.renderInitialMessages).toHaveBeenCalledTimes(1);
		expect(fakes.showStatus).toHaveBeenCalledWith("Reverted undo: code changes and conversation restored.");
		expect(fakes.showError).not.toHaveBeenCalled();
	});

	it("reverts files only when no rewind target was recorded", async () => {
		const fakes = createInstance({ getRevertLeafId: vi.fn(() => undefined) });

		await fakes.instance.defaultEditor.onSubmit("/revert");

		expect(fakes.revertUndo).toHaveBeenCalledTimes(1);
		expect(fakes.navigateTree).not.toHaveBeenCalled();
		expect(fakes.showStatus).toHaveBeenCalledWith("Reverted undo: code changes restored.");
	});

	it("warns when the redo navigation is cancelled", async () => {
		const fakes = createInstance({
			getRevertLeafId: vi.fn(() => "leaf-9"),
			navigateTree: vi.fn(async () => ({ cancelled: true })),
		});

		await fakes.instance.defaultEditor.onSubmit("/revert");

		expect(fakes.showWarning).toHaveBeenCalledWith(
			"Restored code changes, but the conversation was not moved forward.",
		);
		expect(fakes.showStatus).not.toHaveBeenCalled();
	});

	it("warns when the redo navigation throws", async () => {
		const fakes = createInstance({
			getRevertLeafId: vi.fn(() => "leaf-9"),
			navigateTree: vi.fn(async () => {
				throw new Error("boom");
			}),
		});

		await fakes.instance.defaultEditor.onSubmit("/revert");

		expect(fakes.showWarning).toHaveBeenCalledWith(
			"Restored code changes, but moving the conversation forward failed: boom",
		);
		expect(fakes.showStatus).not.toHaveBeenCalled();
	});

	it("shows an error and does not navigate when /revert fails", async () => {
		const fakes = createInstance({
			getRevertLeafId: vi.fn(() => "leaf-9"),
			revertUndo: vi.fn(async () => {
				throw new Error("No active revert found");
			}),
		});

		await fakes.instance.defaultEditor.onSubmit("/revert");

		expect(fakes.showError).toHaveBeenCalledWith("Failed to revert: No active revert found");
		expect(fakes.navigateTree).not.toHaveBeenCalled();
	});
});
