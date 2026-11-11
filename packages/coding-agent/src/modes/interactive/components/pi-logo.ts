import { foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * The MANA wordmark in the ANSI Shadow font: 6 lines tall and 40 cells wide. The first line is padded
 * to the same width as the rest so every line centers the same way.
 */
const MANA_LOGO_LINES = [
	"███╗   ███╗  █████╗  ███╗   ██╗  █████╗ ",
	"████╗ ████║ ██╔══██╗ ████╗  ██║ ██╔══██╗",
	"██╔████╔██║ ███████║ ██╔██╗ ██║ ███████║",
	"██║╚██╔╝██║ ██╔══██║ ██║╚██╗██║ ██╔══██║",
	"██║ ╚═╝ ██║ ██║  ██║ ██║ ╚████║ ██║  ██║",
	"╚═╝     ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝ ╚═╝  ╚═╝",
] as const;

/** The full MANA block logo, uncolored. Callers apply theme colors. */
export function manaLogoLines(): readonly string[] {
	return MANA_LOGO_LINES;
}

/**
 * Whether the terminal renders the block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the block characters, so it gets the text wordmark instead.
 */
export function supportsManaLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: "Mana" with the logo's coral and yellow. */
export function manaWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}M${RESET}${foregroundAnsi(YELLOW, mode)}ana${RESET}`;
}

/** Deprecated compatibility alias for manaLogoLines. */
export const piLogoLines = manaLogoLines;
/** Deprecated compatibility alias for supportsManaLogo. */
export const supportsPiLogo = supportsManaLogo;
/** Deprecated compatibility alias for manaWordmark. */
export const piWordmark = manaWordmark;
