import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface UserMessage {
	role: "user";
	content: string;
	timestamp: number;
}

function userEntry(id: string, message: UserMessage) {
	return { type: "message", id, message };
}

/** Click handlers resolve the turn at click time, after the session appended the entry. */
function createInstance(branch: unknown[], overrides: Record<string, unknown> = {}) {
	const instance = Object.create(InteractiveMode.prototype);
	instance.runtimeHost = {
		session: {
			sessionManager: { getBranch: () => branch },
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			...overrides,
		},
	};
	return instance;
}

describe("InteractiveMode click-to-undo", () => {
	it("resolves live and restored user messages to their branch turn", () => {
		const first: UserMessage = { role: "user", content: "one", timestamp: 1 };
		const second: UserMessage = { role: "user", content: "two", timestamp: 2 };
		const third: UserMessage = { role: "user", content: "three", timestamp: 3 };
		const instance = createInstance([
			userEntry("e1", first),
			{ type: "message", id: "a1", message: { role: "assistant", content: [], timestamp: 1 } },
			userEntry("e2", second),
			userEntry("e3", third),
		]);

		expect(instance.findUserMessageTurnId(third)).toBe(3);
		expect(instance.findUserMessageTurnId({ role: "user", content: "two", timestamp: 2 }, "e2")).toBe(2);
		expect(instance.findUserMessageTurnId({ role: "user", content: "missing", timestamp: 0 })).toBeUndefined();
	});

	it("warns instead of undoing when the message matches no entry", async () => {
		const undoToCheckpoint = vi.fn();
		const showExtensionConfirm = vi.fn();
		const showWarning = vi.fn();
		const instance = createInstance([], { checkpointManager: { undoToCheckpoint } });
		instance.showWarning = showWarning;
		instance.showExtensionConfirm = showExtensionConfirm;

		await instance.showUndoModal({ role: "user", content: "missing", timestamp: 0 });

		expect(showWarning).toHaveBeenCalledWith("No checkpoint found for this message.");
		expect(showExtensionConfirm).not.toHaveBeenCalled();
		expect(undoToCheckpoint).not.toHaveBeenCalled();
	});

	it("undoes the resolved branch turn after confirmation", async () => {
		const first: UserMessage = { role: "user", content: "one", timestamp: 1 };
		const second: UserMessage = { role: "user", content: "two", timestamp: 2 };
		const getCheckpointDiff = vi.fn(async () => ({ hasCheckpoint: true, added: 3, deleted: 4 }));
		const undoToCheckpoint = vi.fn(async () => ({ revertId: "r1", revertAdded: 0, revertDeleted: 0 }));
		const instance = createInstance([userEntry("e1", first), userEntry("e2", second)], {
			checkpointManager: { getCheckpointDiff, undoToCheckpoint },
		});
		instance.showExtensionConfirm = vi.fn(async () => true);
		instance.showStyledStatus = vi.fn();
		instance.showError = vi.fn();
		instance.clearStatusIndicator = vi.fn();

		await instance.showUndoModal(second);

		expect(getCheckpointDiff).toHaveBeenCalledWith(2);
		expect(undoToCheckpoint).toHaveBeenCalledWith(2);
	});
});
