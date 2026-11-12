/**
 * Startup backdrop - the shared animated background behind both startup views.
 *
 * Owns the frame clock, caches one scene render per frame, and composites the braille rows behind
 * foreground text. The fullscreen start screen and the regular-mode header use the same instance,
 * so only one timer runs. Motion is disabled by `NO_COLOR` or `PI_REDUCED_MOTION=1`.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { renderStartupScene } from "./startup-scene.ts";

const DEFAULT_INTERVAL_MS = 100;
/** Below this size the scene is unreadable, so the foreground stays plain. */
const MIN_COLUMNS = 40;
/** The regular-mode header band is a few rows tall; the gate only rejects a sliver. */
const MIN_ROWS = 4;

export interface StartupBackdropOptions {
	readonly requestRender: () => void;
	readonly intervalMs?: number;
}

/** Whether the environment disables startup motion. pi has no OS-level reduced-motion source. */
export function startupAnimationDisabled(): boolean {
	return process.env.NO_COLOR !== undefined || process.env.PI_REDUCED_MOTION === "1";
}

export class StartupBackdrop {
	private readonly requestRender: () => void;
	private readonly intervalMs: number;
	private active = false;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private cache: { width: number; rows: number; frame: number; lines: string[] } | undefined;

	constructor(options: StartupBackdropOptions) {
		this.requestRender = options.requestRender;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	}

	/** Start or stop the frame clock; inactive or disabled motion renders no background. */
	setActive(active: boolean): void {
		if (active === this.active) return;
		this.active = active;
		if (!active) {
			this.stopTimer();
			return;
		}
		if (startupAnimationDisabled()) return;
		this.timer = setInterval(() => {
			this.frame += 1;
			this.requestRender();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	/** Plain braille rows for the current frame, or undefined when there is no background. */
	render(width: number, rows: number): string[] | undefined {
		if (!this.active || startupAnimationDisabled() || width < MIN_COLUMNS || rows < MIN_ROWS) return undefined;
		const cached = this.cache;
		if (cached && cached.width === width && cached.rows === rows && cached.frame === this.frame) return cached.lines;
		const lines = renderStartupScene(width, rows, this.frame * this.intervalMs);
		this.cache = { width, rows, frame: this.frame, lines };
		return lines;
	}

	/** Foreground lines with the background visible to their right, staying within `width`. */
	composite(width: number, foreground: string[]): string[] {
		const background = this.render(width, foreground.length);
		if (!background) return foreground;
		return foreground.map((line, index) => {
			const trimmed = line.replace(/ +$/, "");
			const padding = background[index]!.slice(visibleWidth(trimmed));
			return padding.length === 0 ? trimmed : trimmed + theme.fg("dim", padding);
		});
	}

	/** Stop the frame clock and render nothing afterwards. */
	dispose(): void {
		this.active = false;
		this.stopTimer();
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
