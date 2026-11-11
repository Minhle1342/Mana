import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode /undo and /revert commands", () => {
	it("registers /undo and /revert in BUILTIN_SLASH_COMMANDS", () => {
		const undoCmd = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === "undo");
		expect(undoCmd).toBeDefined();
		expect(undoCmd?.description.toLowerCase()).toContain("checkpoint");

		const revertCmd = BUILTIN_SLASH_COMMANDS.find((cmd) => cmd.name === "revert");
		expect(revertCmd).toBeDefined();
		expect(revertCmd?.description.toLowerCase()).toContain("revert");
	});

	it("executes /undo and shows a colorized status on success", async () => {
		const undoToCheckpoint = vi.fn(async () => ({
			revertId: "rev-1",
			revertAdded: 5,
			revertDeleted: 2,
		}));
		const showStyledStatus = vi.fn();
		const showError = vi.fn();
		const showWarning = vi.fn();
		const clearStatusIndicator = vi.fn();
		const setText = vi.fn();

		const instance = Object.create(InteractiveMode.prototype);
		instance.runtimeHost = {
			session: {
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				checkpointManager: { undoToCheckpoint },
			},
		};
		instance.defaultEditor = {};
		instance.editor = { setText };
		instance.showStyledStatus = showStyledStatus;
		instance.showError = showError;
		instance.showWarning = showWarning;
		instance.clearStatusIndicator = clearStatusIndicator;

		instance.setupEditorSubmitHandler();

		await instance.defaultEditor.onSubmit("/undo");

		expect(setText).toHaveBeenCalledWith("");
		expect(undoToCheckpoint).toHaveBeenCalledWith(undefined);
		initTheme("dark");
		const message = showStyledStatus.mock.calls[0]?.[0]();
		expect(stripAnsi(message)).toBe("Undid changes to checkpoint (+2 restored, -5 removed). Use /revert to restore.");
		expect(message).toContain(theme.fg("toolDiffAdded", "+2 restored"));
		expect(message).toContain(theme.fg("toolDiffRemoved", "-5 removed"));
		expect(showError).not.toHaveBeenCalled();
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("executes /undo with target turn argument", async () => {
		const undoToCheckpoint = vi.fn(async () => ({
			revertId: "rev-2",
			revertAdded: 0,
			revertDeleted: 1,
		}));
		const showStyledStatus = vi.fn();
		const setText = vi.fn();

		const instance = Object.create(InteractiveMode.prototype);
		instance.runtimeHost = {
			session: {
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				checkpointManager: { undoToCheckpoint },
			},
		};
		instance.defaultEditor = {};
		instance.editor = { setText };
		instance.showStyledStatus = showStyledStatus;
		instance.showError = vi.fn();
		instance.showWarning = vi.fn();
		instance.clearStatusIndicator = vi.fn();

		instance.setupEditorSubmitHandler();

		await instance.defaultEditor.onSubmit("/undo 3");

		expect(undoToCheckpoint).toHaveBeenCalledWith("3");
		initTheme("dark");
		const message = showStyledStatus.mock.calls[0]?.[0]();
		expect(stripAnsi(message)).toBe("Undid changes to checkpoint (+1 restored, -0 removed). Use /revert to restore.");
	});

	it("rejects /undo while agent is streaming", async () => {
		const undoToCheckpoint = vi.fn();
		const showWarning = vi.fn();
		const setText = vi.fn();

		const instance = Object.create(InteractiveMode.prototype);
		instance.runtimeHost = {
			session: {
				isStreaming: true,
				isCompacting: false,
				isBashRunning: false,
				checkpointManager: { undoToCheckpoint },
			},
		};
		instance.defaultEditor = {};
		instance.editor = { setText };
		instance.showStatus = vi.fn();
		instance.showError = vi.fn();
		instance.showWarning = showWarning;
		instance.clearStatusIndicator = vi.fn();

		instance.setupEditorSubmitHandler();

		await instance.defaultEditor.onSubmit("/undo");

		expect(setText).toHaveBeenCalledWith("");
		expect(undoToCheckpoint).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("Wait for the current response to finish before undoing.");
	});

	it("executes /revert and shows status on success", async () => {
		const revertUndo = vi.fn(async () => ({ success: true }));
		const showStatus = vi.fn();
		const showError = vi.fn();
		const setText = vi.fn();

		const instance = Object.create(InteractiveMode.prototype);
		instance.runtimeHost = {
			session: {
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				checkpointManager: { revertUndo },
			},
		};
		instance.defaultEditor = {};
		instance.editor = { setText };
		instance.showStatus = showStatus;
		instance.showError = showError;
		instance.showWarning = vi.fn();
		instance.clearStatusIndicator = vi.fn();

		instance.setupEditorSubmitHandler();

		await instance.defaultEditor.onSubmit("/revert");

		expect(setText).toHaveBeenCalledWith("");
		expect(revertUndo).toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Reverted undo: code changes restored.");
		expect(showError).not.toHaveBeenCalled();
	});

	it("shows error when /revert fails", async () => {
		const revertUndo = vi.fn(async () => {
			throw new Error("No active revert found");
		});
		const showError = vi.fn();
		const setText = vi.fn();

		const instance = Object.create(InteractiveMode.prototype);
		instance.runtimeHost = {
			session: {
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				checkpointManager: { revertUndo },
			},
		};
		instance.defaultEditor = {};
		instance.editor = { setText };
		instance.showStatus = vi.fn();
		instance.showError = showError;
		instance.showWarning = vi.fn();
		instance.clearStatusIndicator = vi.fn();

		instance.setupEditorSubmitHandler();

		await instance.defaultEditor.onSubmit("/revert");

		expect(setText).toHaveBeenCalledWith("");
		expect(showError).toHaveBeenCalledWith("Failed to revert: No active revert found");
	});
});
