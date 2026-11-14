// The durable store of one pi session: its subagent conversations, beside the session's own transcript file.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SessionManager } from "../session-manager.ts";

/**
 * Opens the durable storage for a session. The file follows the session file rather than the session id: a resume
 * reopens the same store, while `/new`, a fork and an import each get their own. A session without a file (in-memory,
 * or an unwritable session directory) uses `agentDir`.
 */
export function openDurableStore(sessionManager: SessionManager, agentDir: string): Promise<Storage> {
	const file = sessionManager.getSessionFile();
	const path =
		file === undefined
			? join(agentDir, "durable", `${sessionManager.getSessionId()}.sqlite`)
			: `${file.slice(0, -".jsonl".length)}.sqlite`;
	mkdirSync(dirname(path), { recursive: true });
	return openNodeSqliteStorage(path);
}
