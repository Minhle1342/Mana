import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import {
	manaLogoLines,
	manaWordmark,
	piLogoLines,
	piWordmark,
	supportsManaLogo,
	supportsPiLogo,
} from "../src/modes/interactive/components/pi-logo.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeEach(() => initTheme("dark"));

describe("manaLogoLines", () => {
	it("returns 6 lines of the MANA block logo", () => {
		const lines = manaLogoLines();
		expect(lines).toHaveLength(6);
	});

	it("pads every line to the same visible width (40 cells) so they center uniformly", () => {
		const lines = manaLogoLines();
		const widths = new Set(lines.map((line) => visibleWidth(line)));
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBe(40);
	});

	it("pads the first line with a trailing space to match the rest", () => {
		const lines = manaLogoLines();
		expect(lines[0]).toBe(`${lines[0].replace(/\s+$/, "")} `);
		expect(lines[0].length).toBe(lines[1].length);
	});

	it("provides piLogoLines as a backward-compatible alias", () => {
		expect(piLogoLines).toBe(manaLogoLines);
	});
});

describe("manaWordmark", () => {
	it("is the Mana wordmark with brand colors", () => {
		const mark = manaWordmark();
		expect(mark).toContain("M");
		expect(mark).toContain("ana");
		expect(visibleWidth(mark)).toBe(4);
	});

	it("provides piWordmark as a backward-compatible alias", () => {
		expect(piWordmark).toBe(manaWordmark);
	});
});

describe("supportsManaLogo", () => {
	it("returns a boolean (true outside Apple Terminal)", () => {
		expect(typeof supportsManaLogo()).toBe("boolean");
		expect(supportsManaLogo()).toBe(true);
	});

	it("provides supportsPiLogo as a backward-compatible alias", () => {
		expect(supportsPiLogo).toBe(supportsManaLogo);
	});
});
