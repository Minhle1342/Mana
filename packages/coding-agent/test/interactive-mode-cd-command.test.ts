import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CdCommandContext = {
	getPathCommandArgument: (text: string, command: string) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as CdCommandContext;

describe("InteractiveMode /cd parsing", () => {
	it("strips quotes from /cd path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/cd "path/to/workspace"', "/cd")).toBe(
			"path/to/workspace",
		);
		expect(interactiveModePrototype.getPathCommandArgument('/cd "path with spaces"', "/cd")).toBe("path with spaces");
	});

	it("preserves apostrophes in unquoted /cd path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/cd john's/workspace", "/cd")).toBe("john's/workspace");
	});

	it("enforces command token boundaries for /cd", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/cddir /tmp/workspace", "/cd")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/cdx /tmp/workspace", "/cd")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/cd /tmp/workspace", "/cd")).toBe("/tmp/workspace");
	});

	it("returns undefined for a bare /cd with no path argument", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/cd", "/cd")).toBe(undefined);
	});
});
