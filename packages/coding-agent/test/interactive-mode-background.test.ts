import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/** Instances for handler tests, mirroring the undo-click test harness. */
function createInstance(sessionOverrides: Record<string, unknown>) {
	const instance = Object.create(InteractiveMode.prototype);
	instance.runtimeHost = { session: sessionOverrides };
	instance.showStatus = vi.fn();
	return instance;
}

describe("InteractiveMode Alt+G background handler", () => {
	it("shows the output path when a command is detached", async () => {
		const backgroundBash = vi.fn(async () => ({ status: "detached", outputPath: "/tmp/out.log" }));
		const instance = createInstance({ backgroundBash });

		await instance.handleBackgroundBash();

		expect(backgroundBash).toHaveBeenCalled();
		expect(instance.showStatus).toHaveBeenCalledWith("Command backgrounded; output: /tmp/out.log");
	});

	it("shows statuses for no-command, unsupported, and already-settled cases", async () => {
		const backgroundBash = vi
			.fn()
			.mockResolvedValueOnce({ status: "no-command" })
			.mockResolvedValueOnce({ status: "unsupported" })
			.mockResolvedValueOnce({ status: "settled" });
		const instance = createInstance({ backgroundBash });

		await instance.handleBackgroundBash();
		expect(instance.showStatus).toHaveBeenLastCalledWith("No running shell command to background");

		await instance.handleBackgroundBash();
		expect(instance.showStatus).toHaveBeenLastCalledWith("This shell backend does not support backgrounding");

		await instance.handleBackgroundBash();
		expect(instance.showStatus).toHaveBeenLastCalledWith("The shell command already finished or stopped");
	});
});
