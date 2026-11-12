/**
 * Startup scene - the animated braille backdrop shared by both startup views.
 *
 * A perspective camera slowly yaws and pitches. One ray per braille dot is cast against a ground
 * and ceiling grid, and a small rotating point constellation is projected with the same matrix.
 * Hits are packed into braille glyphs. The output is a pure function of size and time.
 */

/** Braille dot bits, indexed by row * 2 + column within the 2x4 cell. */
const DOT_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
const BRAILLE = Array.from({ length: 256 }, (_, bits) => String.fromCharCode(0x2800 + bits));

/** World grid spacing, plane heights, and the distance where hits stop. */
const GRID_SPACING = 1;
const FLOOR_Y = -1;
const CEILING_Y = 1;
const FAR = 14;
/** Half-width of a grid line in grid units; larger reads as a denser, brighter field. */
const LINE_WIDTH = 0.045;

/** Deterministic constellation in view space: x, y, z triplets behind the camera. */
const POINTS = createPoints(48);

function createPoints(count: number): number[] {
	const points: number[] = [];
	let seed = 0x9e3779b9;
	const random = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
	for (let index = 0; index < count; index++) {
		const angle = random() * Math.PI * 2;
		const radius = 1.4 + random() * 2.2;
		points.push(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.5, -(3 + random() * 8));
	}
	return points;
}

/** Set the braille dot at `dotX`, `dotY` in the cell buffer. */
function setDot(bits: Uint8Array, cellColumns: number, dotX: number, dotY: number): void {
	const cell = Math.floor(dotY / 4) * cellColumns + Math.floor(dotX / 2);
	bits[cell]! |= DOT_BITS[(dotY & 3) * 2 + (dotX & 1)];
}

/** Render `rows` rows of `columns` braille glyphs for the startup backdrop. */
export function renderStartupScene(columns: number, rows: number, timeMs: number): string[] {
	const cellColumns = Math.max(1, Math.floor(columns));
	const cellRows = Math.max(1, Math.floor(rows));
	const dotWidth = cellColumns * 2;
	const dotHeight = cellRows * 4;

	const time = timeMs / 1000;
	const yaw = time * 0.09;
	const pitch = -0.22 + Math.sin(time * 0.35) * 0.1;
	const cosYaw = Math.cos(yaw);
	const sinYaw = Math.sin(yaw);
	const cosPitch = Math.cos(pitch);
	const sinPitch = Math.sin(pitch);

	const bits = new Uint8Array(cellColumns * cellRows);
	const depth = new Float32Array(dotWidth * dotHeight).fill(Infinity);
	// Keep the field square: the vertical field of view shrinks with the band height.
	const aspect = dotHeight / dotWidth;

	// One ray per braille dot, from the camera at the origin through the cell grid.
	for (let dotY = 0; dotY < dotHeight; dotY++) {
		const ndcY = (((dotY + 0.5) / dotHeight) * 2 - 1) * aspect;
		for (let dotX = 0; dotX < dotWidth; dotX++) {
			const ndcX = ((dotX + 0.5) / dotWidth) * 2 - 1;

			// Yaw around Y, then pitch around X.
			const x1 = ndcX * cosYaw - sinYaw;
			const z1 = -ndcX * sinYaw - cosYaw;
			const y2 = ndcY * cosPitch - z1 * sinPitch;
			const z2 = ndcY * sinPitch + z1 * cosPitch;

			const index = dotY * dotWidth + dotX;
			if (Math.abs(y2) < 1e-4) continue;
			const planeY = y2 < 0 ? FLOOR_Y : CEILING_Y;
			const distance = planeY / y2;
			if (distance <= 0 || distance > FAR) continue;

			const px = x1 * distance;
			const pz = z2 * distance;
			const u = px / GRID_SPACING;
			const v = pz / GRID_SPACING;
			const du = Math.abs(u - Math.round(u));
			const dv = Math.abs(v - Math.round(v));
			if (Math.min(du, dv) > LINE_WIDTH) continue;

			depth[index] = distance;
			setDot(bits, cellColumns, dotX, dotY);
		}
	}

	// Project the constellation and keep only points in front of the grid hit at that dot.
	for (let point = 0; point < POINTS.length; point += 3) {
		const px = POINTS[point]!;
		const py = POINTS[point + 1]!;
		const pz = POINTS[point + 2]!;
		const x1 = px * cosYaw + pz * sinYaw;
		const z1 = -px * sinYaw + pz * cosYaw;
		const y2 = py * cosPitch - z1 * sinPitch;
		const z2 = py * sinPitch + z1 * cosPitch;
		if (z2 >= -0.1) continue;

		const inverseDistance = 1 / -z2;
		const dotX = Math.floor(((x1 * inverseDistance + 1) / 2) * dotWidth);
		const dotY = Math.floor((((y2 * inverseDistance) / aspect + 1) / 2) * dotHeight);
		if (dotX < 0 || dotX >= dotWidth || dotY < 0 || dotY >= dotHeight) continue;

		const index = dotY * dotWidth + dotX;
		if (-z2 >= depth[index]!) continue;
		setDot(bits, cellColumns, dotX, dotY);
	}

	const lines: string[] = [];
	for (let row = 0; row < cellRows; row++) {
		let line = "";
		for (let column = 0; column < cellColumns; column++) {
			line += BRAILLE[bits[row * cellColumns + column]!]!;
		}
		lines.push(line);
	}
	return lines;
}
