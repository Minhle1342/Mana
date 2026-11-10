/**
 * TabBar - renders a fixed top bar of session tabs with mouse hit testing.
 *
 * Each tab displays its name (truncated to 15 characters when idle, sliding on
 * hover when longer), an in-flight indicator (`* `) when streaming, an active
 * highlight (`\x1b[7m`), a close button (`x`) for inactive tabs, and a trailing
 * `+` to add new tabs. Mouse left-clicks switch, close, or add tabs. Right-clicking
 * a tab triggers the rename modal dialog.
 */
import type { Component, TuiInputListener, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TabSlot } from "../../../core/session-tab-manager.ts";

export const MAX_TAB_NAME_LENGTH = 15;
export const SLIDE_INTERVAL_MS = 140;
export const SLIDE_PAUSE_TICKS = 3;

export interface TabBarProps {
	tabs: readonly TabSlot[];
	activeId: string | undefined;
	onSwitch: (id: string) => void;
	onAdd: () => void;
	onClose: (id: string) => void;
	onRename?: (id: string) => void;
	requestRender?: () => void;
	addInputListener?: (listener: TuiInputListener) => () => void;
}

interface TabRegion {
	readonly type: "tab";
	readonly tabId: string;
	readonly xStart: number;
	readonly xEnd: number;
	readonly onLeftClick: () => void;
	readonly onRightClick?: () => void;
}

interface ActionRegion {
	readonly type: "action";
	readonly xStart: number;
	readonly xEnd: number;
	readonly onClick: () => void;
}

type HitRegion = TabRegion | ActionRegion;

export function formatTabDisplayName(name: string, isHovered: boolean, offset: number): string {
	if (name.length <= MAX_TAB_NAME_LENGTH) {
		return name;
	}
	if (!isHovered) {
		return `${name.slice(0, 12)}...`;
	}
	const maxOffset = name.length - MAX_TAB_NAME_LENGTH;
	const clampedOffset = Math.min(offset, maxOffset);
	return name.slice(clampedOffset, clampedOffset + MAX_TAB_NAME_LENGTH).padEnd(MAX_TAB_NAME_LENGTH, " ");
}

export class TabBar implements Component {
	private props: TabBarProps;
	private regions: HitRegion[] = [];
	private hoveredTabId: string | undefined;
	private scrollOffset = 0;
	private slideTimer: ReturnType<typeof setInterval> | undefined;
	private unsubscribeInput: (() => void) | undefined;

	constructor(props: TabBarProps) {
		this.props = props;
		this.setupInputListener();
	}

	setProps(props: TabBarProps): void {
		this.props = props;
		if (this.hoveredTabId && !props.tabs.some((t) => t.id === this.hoveredTabId)) {
			this.hoveredTabId = undefined;
			this.stopSlideTimer();
		}
		this.setupInputListener();
	}

	private setupInputListener(): void {
		if (this.unsubscribeInput || !this.props.addInputListener) return;
		this.unsubscribeInput = this.props.addInputListener((data) => {
			if (this.hoveredTabId === undefined) return undefined;
			const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
			if (sgr) {
				const y = Number.parseInt(sgr[3], 10) - 1;
				if (y !== 0) {
					this.hoveredTabId = undefined;
					this.stopSlideTimer();
					this.props.requestRender?.();
				}
			} else {
				this.hoveredTabId = undefined;
				this.stopSlideTimer();
				this.props.requestRender?.();
			}
			return undefined;
		});
	}

	private startSlideTimer(tab: TabSlot): void {
		this.stopSlideTimer();
		if (tab.name.length <= MAX_TAB_NAME_LENGTH) return;
		const maxOffset = tab.name.length - MAX_TAB_NAME_LENGTH;
		const totalTicks = maxOffset + SLIDE_PAUSE_TICKS;
		this.slideTimer = setInterval(() => {
			this.scrollOffset = (this.scrollOffset + 1) % totalTicks;
			this.props.requestRender?.();
		}, SLIDE_INTERVAL_MS);
	}

	private stopSlideTimer(): void {
		if (this.slideTimer !== undefined) {
			clearInterval(this.slideTimer);
			this.slideTimer = undefined;
		}
		this.scrollOffset = 0;
	}

	render(width: number): string[] {
		this.regions = [];
		const { tabs, activeId, onSwitch, onClose, onAdd } = this.props;
		const safeWidth = Math.max(1, width);
		let x = 0;
		const parts: string[] = [];

		for (const tab of tabs) {
			const active = tab.id === activeId;
			const isBusy = tab.session.isStreaming;
			const isHovered = tab.id === this.hoveredTabId;
			const baseName = formatTabDisplayName(tab.name, isHovered, isHovered ? this.scrollOffset : 0);
			const name = isBusy ? `* ${baseName}` : baseName;
			const tabLabel = ` ${name} `;
			const tabWidth = visibleWidth(tabLabel);

			if (x + tabWidth > safeWidth) break;

			this.regions.push({
				type: "tab",
				tabId: tab.id,
				xStart: x,
				xEnd: x + tabWidth,
				onLeftClick: () => onSwitch(tab.id),
				onRightClick: () => this.props.onRename?.(tab.id),
			});
			parts.push(active ? `\x1b[7m${tabLabel}\x1b[27m` : tabLabel);
			x += tabWidth;

			if (!active && tabs.length > 1) {
				const closeLabel = " x ";
				const closeWidth = 3;
				if (x + closeWidth <= safeWidth) {
					this.regions.push({
						type: "action",
						xStart: x,
						xEnd: x + closeWidth,
						onClick: () => onClose(tab.id),
					});
					parts.push(`\x1b[90m${closeLabel}\x1b[39m`);
					x += closeWidth;
				}
			}

			// Separator
			if (x + 1 <= safeWidth) {
				parts.push("│");
				x += 1;
			}
		}

		// Add button
		const addLabel = " + ";
		const addWidth = 3;
		if (x + addWidth <= safeWidth) {
			this.regions.push({
				type: "action",
				xStart: x,
				xEnd: x + addWidth,
				onClick: onAdd,
			});
			parts.push(addLabel);
			x += addWidth;
		}

		return [parts.join("")];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y !== 0) {
			if (this.hoveredTabId !== undefined) {
				this.hoveredTabId = undefined;
				this.stopSlideTimer();
				return { handled: true, render: true };
			}
			return undefined;
		}

		if (event.type === "move") {
			const region = this.regions.find((r) => event.x >= r.xStart && event.x < r.xEnd);
			const targetTabId = region?.type === "tab" ? region.tabId : undefined;
			if (targetTabId !== this.hoveredTabId) {
				this.hoveredTabId = targetTabId;
				this.stopSlideTimer();
				if (targetTabId !== undefined) {
					const tab = this.props.tabs.find((t) => t.id === targetTabId);
					if (tab && tab.name.length > MAX_TAB_NAME_LENGTH) {
						this.startSlideTimer(tab);
					}
				}
				return { handled: true, render: true };
			}
			return { handled: true };
		}

		const region = this.regions.find((r) => event.x >= r.xStart && event.x < r.xEnd);
		if (!region) return undefined;

		if (event.type === "press") {
			return { handled: true };
		}

		if (event.type === "click") {
			if (event.button === "right") {
				if (region.type === "tab") {
					region.onRightClick?.();
					return { handled: true };
				}
				return undefined;
			}
			if (region.type === "tab") {
				region.onLeftClick();
				return { handled: true };
			}
			region.onClick();
			return { handled: true };
		}

		return undefined;
	}

	invalidate(): void {}

	dispose(): void {
		this.stopSlideTimer();
		if (this.unsubscribeInput) {
			this.unsubscribeInput();
			this.unsubscribeInput = undefined;
		}
	}
}
