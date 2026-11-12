import { describe, expect, it } from "vitest";
import { renderStartupScene } from "../src/modes/interactive/components/startup-scene.ts";

const BRAILLE_OR_SPACE = /^[\u2800-\u28ff ]+$/;

describe("renderStartupScene", () => {
	it("returns the requested number of rows and cells", () => {
		const lines = renderStartupScene(80, 12, 0);
		expect(lines).toHaveLength(12);
		for (const line of lines) expect(line).toHaveLength(80);
	});

	it("draws only braille glyphs and spaces", () => {
		for (const line of renderStartupScene(60, 10, 250)) expect(line).toMatch(BRAILLE_OR_SPACE);
	});

	it("is deterministic for the same size and time", () => {
		expect(renderStartupScene(80, 12, 500)).toEqual(renderStartupScene(80, 12, 500));
	});

	it("changes over time", () => {
		expect(renderStartupScene(80, 12, 0)).not.toEqual(renderStartupScene(80, 12, 1000));
	});

	it("keeps a short wide header band sparse", () => {
		const columns = 78;
		const rows = 5;
		const ink = renderStartupScene(columns, rows, 0)
			.join("")
			.split("")
			.filter((char) => char !== " ").length;
		expect(ink / (columns * rows * 8)).toBeLessThan(0.25);
	});

	it("does not throw for degenerate sizes", () => {
		expect(renderStartupScene(5, 3, 0)).toHaveLength(3);
	});
});
