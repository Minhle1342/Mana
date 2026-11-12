/**
 * StartScreen - empty-session start screen shown under the tab bar.
 *
 * Renders the centered MANA block logo (ANSI Shadow), the command editor and
 * the footer directly below it, vertically centered in the terminal. While
 * active the editor's output is rendered here (the editor stays mounted in the
 * dock); on the first submit or a switch to a non-empty tab the start screen
 * hides and the editor renders in the dock as usual.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { manaWordmark, supportsManaLogo } from "./pi-logo.ts";
import type { StartupBackdrop } from "./startup-backdrop.ts";

export interface StartScreenProps {
	readonly logoLines: readonly string[];
	readonly editor: Component;
	/** Rendered as one block directly below the editor, like the dock footer. */
	readonly footer: Component;
	/** Current terminal height in rows, queried on every render so resizes stay centered. */
	readonly getHeight: () => number;
	/** Animated background shared with the regular-mode header; absent keeps the plain screen. */
	readonly backdrop?: StartupBackdrop;
	onLogoClick?: (column: number, row: number) => void;
}

/** The widest logo line, in cells. */
function logoWidth(logoLines: readonly string[]): number {
	return Math.max(...logoLines.map((line) => visibleWidth(line)));
}

/** Left column that centers `cells` columns of content in `width`, or 0 when they do not fit. */
function centeredLeft(cells: number, width: number): number {
	return cells >= width ? 0 : Math.floor((width - cells) / 2);
}

/** Pad a single rendered line with spaces so its visible content is centered in `width`. */
function centerLine(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const vw = visibleWidth(line);
	if (vw >= safeWidth) return line;
	const left = centeredLeft(vw, safeWidth);
	const right = safeWidth - vw - left;
	return " ".repeat(left) + line + " ".repeat(right);
}

/** `part` in the dim color, or nothing when there is nothing to draw. */
function dimPart(part: string): string {
	return part.length > 0 ? theme.fg("dim", part) : "";
}

/**
 * `line` placed at column `left` over a background row. The rest of the row keeps the background, dimmed, so the line
 * stays exactly as wide as the same row without a backdrop.
 */
function overlayBackground(scene: string, left: number, line: string): string {
	return dimPart(scene.slice(0, left)) + line + dimPart(scene.slice(left + visibleWidth(line)));
}

/** Start screen component: logo above editor above footer, the whole block vertically centered. */
export class StartScreen implements Component {
	private props: StartScreenProps;
	// Layout captured by the last render, so handleMouse can map screen
	// coordinates back into the logo / editor regions.
	private topSpacer = 0;
	private logoHeight = 0;
	private logoLeft = 0;
	private renderedLogoWidth = 0;
	private editorHeight = 0;
	private editorLeft = 0;
	private footerHeight = 0;

	constructor(props: StartScreenProps) {
		this.props = props;
	}

	getProps(): StartScreenProps {
		return this.props;
	}

	setProps(props: StartScreenProps): void {
		this.props = props;
	}

	handleInput(data: string): void {
		const editor = this.props.editor as Component & {
			handleInput?(data: string): void;
			children?: Component[];
		};
		if (editor.handleInput) {
			editor.handleInput(data);
		} else if (editor.children) {
			for (const child of editor.children) {
				(child as Component & { handleInput?(data: string): void }).handleInput?.(data);
			}
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.props.getHeight());

		const editorLines = this.props.editor.render(safeWidth);
		const footerLines = this.props.footer.render(safeWidth);
		// The logo only has to make room for the editor and footer, which are always shown.
		const fixedHeight = editorLines.length + footerLines.length;

		const fullLogoFits =
			supportsManaLogo() &&
			logoWidth(this.props.logoLines) <= safeWidth &&
			height >= this.props.logoLines.length + fixedHeight + 2;

		let logo: readonly string[];
		if (fullLogoFits) {
			logo = this.props.logoLines;
		} else if (height > fixedHeight) {
			logo = [manaWordmark()];
		} else {
			logo = [];
		}

		const coloredLogo = logo.map((line) => theme.fg("accent", line));
		const background = this.props.backdrop?.render(safeWidth, height);
		const backgroundRow = (row: number) => {
			const scene = background?.[row];
			return scene ? dimPart(scene) : " ".repeat(safeWidth);
		};

		this.logoHeight = coloredLogo.length;
		this.renderedLogoWidth = logoWidth(logo);
		this.editorHeight = editorLines.length;
		this.footerHeight = footerLines.length;
		const contentHeight = this.logoHeight + this.editorHeight + footerLines.length;
		this.topSpacer = Math.max(0, Math.floor((height - contentHeight) / 2));
		const bottomSpacer = Math.max(0, height - contentHeight - this.topSpacer);

		const first = coloredLogo[0] ?? "";
		this.logoLeft = visibleWidth(first) >= safeWidth ? 0 : Math.floor((safeWidth - visibleWidth(first)) / 2);

		const maxEditorWidth = Math.max(0, ...editorLines.map((line) => visibleWidth(line)));
		this.editorLeft = maxEditorWidth >= safeWidth ? 0 : Math.floor((safeWidth - maxEditorWidth) / 2);

		const result: string[] = [];
		let row = 0;
		for (let i = 0; i < this.topSpacer; i++) result.push(backgroundRow(row++));
		for (const line of coloredLogo) {
			const scene = background?.[row];
			result.push(
				scene
					? overlayBackground(scene, centeredLeft(visibleWidth(line), safeWidth), line)
					: centerLine(line, safeWidth),
			);
			row++;
		}
		for (const line of editorLines) {
			const vw = visibleWidth(line);
			const scene = background?.[row];
			if (vw >= safeWidth) {
				result.push(line);
			} else if (scene) {
				result.push(overlayBackground(scene, this.editorLeft, line));
			} else {
				const right = Math.max(0, safeWidth - vw - this.editorLeft);
				result.push(" ".repeat(this.editorLeft) + line + " ".repeat(right));
			}
			row++;
		}
		// The footer spans the full width in the dock, so it does here too.
		for (const line of footerLines) {
			const vw = visibleWidth(line);
			result.push(vw >= safeWidth ? line : line + " ".repeat(safeWidth - vw));
			row++;
		}
		for (let i = 0; i < bottomSpacer; i++) result.push(backgroundRow(row++));
		return result;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const logoTop = this.topSpacer;
		const editorTop = logoTop + this.logoHeight;

		// Logo click region -> 3D easter egg (same gesture as the header wordmark).
		// Only trigger on explicit left clicks.
		if (
			this.props.onLogoClick &&
			event.type === "click" &&
			event.button === "left" &&
			this.logoHeight > 0 &&
			event.y >= logoTop &&
			event.y < logoTop + this.logoHeight &&
			event.x >= this.logoLeft &&
			event.x < this.logoLeft + this.renderedLogoWidth
		) {
			this.props.onLogoClick(event.x, event.y);
			return { handled: true };
		}

		// Forward clicks in the editor's vertical range to the editor.
		if (event.y >= editorTop && event.y < editorTop + this.editorHeight) {
			return this.props.editor.handleMouse?.({
				...event,
				x: Math.max(0, event.x - this.editorLeft),
				y: event.y - editorTop,
				height: this.editorHeight,
			});
		}

		// Forward mouse events in the footer's vertical range to the footer.
		const footerTop = editorTop + this.editorHeight;
		if (event.y >= footerTop && event.y < footerTop + this.footerHeight) {
			return this.props.footer.handleMouse?.({
				...event,
				y: event.y - footerTop,
				height: this.footerHeight,
			});
		}
		return undefined;
	}

	invalidate(): void {}

	dispose(): void {}
}
