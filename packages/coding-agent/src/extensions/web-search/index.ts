/**
 * The `web_search` tool as an extension. The CLI loads it as a built-in extension; SDK users add
 * `createWebSearchExtension()` to their extension factories.
 *
 * It is registered active: it needs no credential and makes no request until the model calls it.
 * Disable it with `-builtin:web-search` or a `--tools` loadout.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createWebSearchToolDefinition } from "./tool.ts";

export function createWebSearchExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool(createWebSearchToolDefinition());
	};
}

export default createWebSearchExtension();
