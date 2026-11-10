import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointManager } from "../src/core/checkpoint-manager.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.autocrlf=false",
			...args,
		],
		{ cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
	);

describe("CheckpointManager", () => {
	it("diff, undo, and revert restore modified code accurately", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-test-")));
		try {
			git(directory, "init", "-q");
			const file = join(directory, "index.ts");
			await writeFile(file, "line1\nline2\nline3\nline4\nline5\n");
			git(directory, "add", "index.ts");
			git(directory, "commit", "-q", "-m", "init");

			const manager = new CheckpointManager(directory, "session-1");

			// Turn 1 starts: create checkpoint before edits
			const sha = await manager.createCheckpoint(1);
			expect(sha).toBeTruthy();

			// Edit index.ts (delete line3, add 2 lines)
			await writeFile(file, "line1\nline2\nnew_a\nnew_b\nline4\nline5\n");

			// Diff before undo:
			// 1 line deleted by agent -> restored upon undo (+1)
			// 2 lines added by agent -> removed upon undo (-2)
			const diff = await manager.getCheckpointDiff(1);
			expect(diff.hasCheckpoint).toBe(true);
			expect(diff.added).toBe(1);
			expect(diff.deleted).toBe(2);

			// Execute undo
			const undoResult = await manager.undoToCheckpoint(1);
			expect(undoResult.revertId).toBeTruthy();
			expect(undoResult.revertAdded).toBe(2);
			expect(undoResult.revertDeleted).toBe(1);

			// File is restored to original state
			const contentAfterUndo = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
			expect(contentAfterUndo).toBe("line1\nline2\nline3\nline4\nline5\n");

			// Execute revert
			const revertResult = await manager.revertUndo(undoResult.revertId);
			expect(revertResult.success).toBe(true);

			// File is restored to modified state
			const contentAfterRevert = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
			expect(contentAfterRevert).toBe("line1\nline2\nnew_a\nnew_b\nline4\nline5\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("handles newly created untracked files across undo and revert", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-untracked-")));
		try {
			git(directory, "init", "-q");
			await writeFile(join(directory, "init.txt"), "hello\n");
			git(directory, "add", "init.txt");
			git(directory, "commit", "-q", "-m", "init");

			const manager = new CheckpointManager(directory, "session-2");

			await manager.createCheckpoint(1);

			const newFile = join(directory, "created.txt");
			await writeFile(newFile, "new file content\n");

			const diff = await manager.getCheckpointDiff(1);
			expect(diff.hasCheckpoint).toBe(true);
			expect(diff.added).toBe(0);
			expect(diff.deleted).toBe(1);

			const undoResult = await manager.undoToCheckpoint(1);
			expect(existsSync(newFile)).toBe(false);

			const revertResult = await manager.revertUndo(undoResult.revertId);
			expect(revertResult.success).toBe(true);
			expect(existsSync(newFile)).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reports hasCheckpoint false when no checkpoint exists", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-none-")));
		try {
			git(directory, "init", "-q");
			await writeFile(join(directory, "init.txt"), "hello\n");
			git(directory, "add", "init.txt");
			git(directory, "commit", "-q", "-m", "init");

			const manager = new CheckpointManager(directory, "session-none");
			const diff = await manager.getCheckpointDiff(1);
			expect(diff.hasCheckpoint).toBe(false);
			expect(diff.added).toBe(0);
			expect(diff.deleted).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("throws when undoing with no checkpoint", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-no-undo-")));
		try {
			git(directory, "init", "-q");
			await writeFile(join(directory, "init.txt"), "hello\n");
			git(directory, "add", "init.txt");
			git(directory, "commit", "-q", "-m", "init");

			const manager = new CheckpointManager(directory, "session-no-undo");
			await expect(manager.undoToCheckpoint(1)).rejects.toThrow(/No checkpoint found for undo/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("survives re-read from git ref (simulated restart/resume)", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-restart-")));
		try {
			git(directory, "init", "-q");
			const file = join(directory, "index.ts");
			await writeFile(file, "line1\nline2\nline3\n");
			git(directory, "add", "index.ts");
			git(directory, "commit", "-q", "-m", "init");

			const manager1 = new CheckpointManager(directory, "session-restart");
			await manager1.createCheckpoint(1);

			await writeFile(file, "line1\nchanged\nline3\n");

			// New manager simulates restart/resume with empty memory
			const manager2 = new CheckpointManager(directory, "session-restart");
			const diff = await manager2.getCheckpointDiff(1);
			expect(diff.hasCheckpoint).toBe(true);
			expect(diff.deleted).toBe(1);

			const undoResult = await manager2.undoToCheckpoint();
			expect(undoResult.revertId).toBeTruthy();

			const contentAfterUndo = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
			expect(contentAfterUndo).toBe("line1\nline2\nline3\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("throws when reverting with no active revert", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-no-revert-")));
		try {
			git(directory, "init", "-q");
			const manager = new CheckpointManager(directory, "session-no-revert");
			await expect(manager.revertUndo()).rejects.toThrow(/No active revert found/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("returns false for isInsideWorkTree on non-git directory", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-nongit-")));
		try {
			const manager = new CheckpointManager(directory, "session-nongit");
			expect(await manager.isInsideWorkTree()).toBe(false);
			expect(await manager.createCheckpoint(1)).toBe(null);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("excludes sqlite and test data files from undo checkout and diff", async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-checkpoint-exclude-")));
		try {
			git(directory, "init", "-q");
			const file = join(directory, "src.ts");
			await writeFile(file, "const a = 1;\n");
			git(directory, "add", "src.ts");
			git(directory, "commit", "-q", "-m", "init");

			const manager = new CheckpointManager(directory, "session-exclude");
			await manager.createCheckpoint(1);

			// Add a sqlite file
			const sqliteFile = join(directory, "database.sqlite");
			await writeFile(sqliteFile, "sqlite binary data");

			await writeFile(file, "const a = 2;\n");

			// diff should only show changes in src.ts, ignoring sqlite
			const diff = await manager.getCheckpointDiff(1);
			expect(diff.hasCheckpoint).toBe(true);
			expect(diff.deleted).toBe(1);

			// undo should restore src.ts without failing
			const undoResult = await manager.undoToCheckpoint(1);
			expect(undoResult.revertId).toBeTruthy();

			const contentAfterUndo = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
			expect(contentAfterUndo).toBe("const a = 1;\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
