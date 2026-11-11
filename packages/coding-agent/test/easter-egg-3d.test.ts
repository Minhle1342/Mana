import { describe, expect, it } from "vitest";
import { MANA_LOGO_PIXELS, manaLogoModel, piLogoModel } from "../src/modes/interactive/components/easter-egg-3d.ts";

describe("manaLogoModel", () => {
	it("constructs a 3D model representing MANA", () => {
		const model = manaLogoModel();
		expect(model.columns).toBe(23);
		expect(model.rows).toBe(5);
		expect(model.blocks.length).toBe(54);
	});

	it("positions blocks in 3D space with valid dimensions", () => {
		const model = manaLogoModel({ column: 10, row: 5 });
		expect(model.origin).toEqual({ column: 10, row: 5 });
		expect(model.cameraDistance).toBeGreaterThan(model.radius);
		expect(model.widthShare).toBeGreaterThan(0);
	});

	it("spells M-A-N-A across four 5x5 blocks separated by single-dot gaps", () => {
		expect(MANA_LOGO_PIXELS).toHaveLength(5);
		for (const row of MANA_LOGO_PIXELS) {
			expect(row).toHaveLength(23);
			// Gap columns 5, 11, 17 must be empty
			expect(row[5]).toBe(".");
			expect(row[11]).toBe(".");
			expect(row[17]).toBe(".");
		}
	});

	it("provides piLogoModel as a backward-compatible alias", () => {
		expect(piLogoModel).toBe(manaLogoModel);
	});
});
