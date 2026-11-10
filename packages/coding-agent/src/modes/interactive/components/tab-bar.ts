/**
 * TabBar - renders a fixed top bar of session tabs with mouse hit testing.
 *
 * Each tab displays its name, an in-flight indicator (`* `) when streaming,
 * an active highlight (`\x1b[7m`), a close button (`x`) for inactive tabs,
 * and a trailing `+` to add new tabs. Mouse clicks directly switch, close,
 * or add tabs without stealing keyboard focus from the editor.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TabSlot } from "../../../core/session-tab-manager.ts";

export interface TabBarProps {
	tabs: readonly TabSlot[];
	activeId: string | undefined;
	onSwitch: (id: string) => void;
	onAdd: () => void;
	onClose: (id: string) => void;
}

interface ButtonRegion {
	readonly xStart: number;
	readonly xEnd: number;
	readonly onClick: () => void;
}

export class TabBar implements Component {
	private props: TabBarProps;
	private regions: ButtonRegion[] = [];

	constructor(props: TabBarProps) {
		this.props = props;
	}

	setProps(props: TabBarProps): void {
		this.props = props;
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
			const name = isBusy ? `* ${tab.name}` : tab.name;
			const tabLabel = ` ${name} `;
			const tabWidth = visibleWidth(tabLabel);

			if (x + tabWidth > safeWidth) break;

			this.regions.push({
				xStart: x,
				xEnd: x + tabWidth,
				onClick: () => onSwitch(tab.id),
			});
			parts.push(active ? `\x1b[7m${tabLabel}\x1b[27m` : tabLabel);
			x += tabWidth;

			if (!active && tabs.length > 1) {
				const closeLabel = " x ";
				const closeWidth = 3;
				if (x + closeWidth <= safeWidth) {
					this.regions.push({
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
		if (event.y !== 0) return undefined;
		const region = this.regions.find((r) => event.x >= r.xStart && event.x < r.xEnd);
		if (!region) return undefined;
		if (event.type === "click") {
			region.onClick();
			return { handled: true };
		}
		if (event.type === "press") {
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {}
}
