import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupBackdrop, startupAnimationDisabled } from "../src/modes/interactive/components/startup-backdrop.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function foregroundLines(count = 10): string[] {
	return Array.from({ length: count }, (_, index) => `line ${index}`);
}

describe("StartupBackdrop", () => {
	beforeEach(() => {
		initTheme("dark");
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("requests a render once per interval while active", () => {
		const requestRender = vi.fn();
		const backdrop = new StartupBackdrop({ requestRender, intervalMs: 100 });
		backdrop.setActive(true);
		vi.advanceTimersByTime(300);
		expect(requestRender).toHaveBeenCalledTimes(3);
		backdrop.dispose();
	});

	it("stops the timer when deactivated and disposed", () => {
		const requestRender = vi.fn();
		const backdrop = new StartupBackdrop({ requestRender, intervalMs: 100 });
		backdrop.setActive(true);
		vi.advanceTimersByTime(100);
		backdrop.setActive(false);
		vi.advanceTimersByTime(300);
		expect(requestRender).toHaveBeenCalledTimes(1);

		backdrop.setActive(true);
		backdrop.dispose();
		vi.advanceTimersByTime(300);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("composites the background within the requested width", () => {
		const backdrop = new StartupBackdrop({ requestRender: () => {} });
		backdrop.setActive(true);
		const foreground = foregroundLines();
		const lines = backdrop.composite(80, foreground);
		expect(lines).toHaveLength(foreground.length);
		for (let index = 0; index < lines.length; index++) {
			expect(lines[index]).toContain(foreground[index]!);
			expect(visibleWidth(lines[index]!)).toBeLessThanOrEqual(80);
		}
		expect(lines[0]).not.toBe(foreground[0]);
		backdrop.dispose();
	});

	it("stays plain when inactive or below the size gate", () => {
		const backdrop = new StartupBackdrop({ requestRender: () => {} });
		const foreground = foregroundLines();
		expect(backdrop.composite(80, foreground)).toBe(foreground);

		backdrop.setActive(true);
		expect(backdrop.composite(30, foreground)).toBe(foreground);
		expect(backdrop.render(80, 3)).toBeUndefined();
		backdrop.dispose();
	});

	it("disables animation and background with NO_COLOR", () => {
		vi.stubEnv("NO_COLOR", "1");
		const requestRender = vi.fn();
		const backdrop = new StartupBackdrop({ requestRender, intervalMs: 100 });
		expect(startupAnimationDisabled()).toBe(true);
		backdrop.setActive(true);
		vi.advanceTimersByTime(300);
		expect(requestRender).not.toHaveBeenCalled();

		const foreground = foregroundLines();
		expect(backdrop.composite(80, foreground)).toBe(foreground);
		backdrop.dispose();
	});

	it("disables animation and background with PI_REDUCED_MOTION=1", () => {
		vi.stubEnv("PI_REDUCED_MOTION", "1");
		const requestRender = vi.fn();
		const backdrop = new StartupBackdrop({ requestRender, intervalMs: 100 });
		expect(startupAnimationDisabled()).toBe(true);
		backdrop.setActive(true);
		vi.advanceTimersByTime(300);
		expect(requestRender).not.toHaveBeenCalled();

		const foreground = foregroundLines();
		expect(backdrop.composite(80, foreground)).toBe(foreground);
		backdrop.dispose();
	});
});
