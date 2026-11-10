import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Workspace } from "../../plugins/workspace/environment.ts";

const context = BACKGROUND_CONTEXT;

const git = (cwd: string, ...args: string[]) =>
	execFileSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
	);

test("checkpoint diff, undo, and revert restore modified code accurately", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-checkpoint-test-")));
	try {
		git(directory, "init", "-q");
		const file = join(directory, "index.ts");
		await writeFile(file, "line1\nline2\nline3\nline4\nline5\n");
		git(directory, "add", "index.ts");
		git(directory, "commit", "-q", "-m", "init");

		const env = new NodeExecutionEnv({ cwd: directory });
		const workspace = new Workspace(env, [], 1);

		// Turn 1 starts: create checkpoint before agent edits
		await workspace.createCheckpoint(1, context);

		// Agent edits index.ts (deletes line3, adds 2 lines)
		await writeFile(file, "line1\nline2\nnew_a\nnew_b\nline4\nline5\n");

		// Inspect diff before undo:
		// Agent added 2 lines and removed 1 line.
		// Upon undo: 1 line is restored (+1), 2 lines are lost (-2).
		const diff = await workspace.getCheckpointDiff({ entryId: 1 }, context);
		assert.equal(diff.hasCheckpoint, true);
		assert.equal(diff.added, 1, "lines restored upon undo");
		assert.equal(diff.deleted, 2, "lines removed upon undo");

		// Execute undo
		const undoResult = await workspace.undoToCheckpoint({ entryId: 1 }, context);
		assert.ok(undoResult.revertId, "returns revertId");
		assert.equal(undoResult.revertAdded, 2, "revert adds the 2 lines back");
		assert.equal(undoResult.revertDeleted, 1, "revert removes the 1 restored line");

		// File is restored to original state
		const contentAfterUndo = await readFile(file, "utf8");
		assert.equal(contentAfterUndo, "line1\nline2\nline3\nline4\nline5\n");

		// Execute revert
		const revertResult = await workspace.revertUndo({ revertId: undoResult.revertId }, context);
		assert.equal(revertResult.success, true);

		// File is restored to agent's modified state
		const contentAfterRevert = await readFile(file, "utf8");
		assert.equal(contentAfterRevert, "line1\nline2\nnew_a\nnew_b\nline4\nline5\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("checkpoint handles newly created untracked files across undo and revert", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-checkpoint-untracked-")));
	try {
		git(directory, "init", "-q");
		await writeFile(join(directory, "init.txt"), "hello\n");
		git(directory, "add", "init.txt");
		git(directory, "commit", "-q", "-m", "init");

		const env = new NodeExecutionEnv({ cwd: directory });
		const workspace = new Workspace(env, [], 2);

		// Checkpoint before turn 2
		await workspace.createCheckpoint(2, context);

		// Agent creates a new untracked file
		const newFile = join(directory, "created.txt");
		await writeFile(newFile, "new file content\n");

		// Diff check: newly created file has 1 line that will be deleted upon undo
		const diff = await workspace.getCheckpointDiff({ entryId: 2 }, context);
		assert.equal(diff.hasCheckpoint, true);
		assert.equal(diff.added, 0);
		assert.equal(diff.deleted, 1);

		// Undo: untracked file should be deleted
		const undoResult = await workspace.undoToCheckpoint({ entryId: 2 }, context);
		assert.equal(existsSync(newFile), false, "untracked file was deleted by undo");

		// Revert: untracked file should be restored
		const revertResult = await workspace.revertUndo({ revertId: undoResult.revertId }, context);
		assert.equal(revertResult.success, true);
		assert.equal(existsSync(newFile), true, "untracked file was restored by revert");
		const content = await readFile(newFile, "utf8");
		assert.equal(content, "new file content\n");

		// Dismiss revert clears the revert entry
		await workspace.dismissRevert({ revertId: undoResult.revertId }, context);
		const secondRevert = await workspace.revertUndo({ revertId: undoResult.revertId }, context);
		assert.equal(secondRevert.success, false, "revert cannot be run after dismissal");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("no checkpoint: getCheckpointDiff reports hasCheckpoint false", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-checkpoint-none-")));
	try {
		git(directory, "init", "-q");
		await writeFile(join(directory, "init.txt"), "hello\n");
		git(directory, "add", "init.txt");
		git(directory, "commit", "-q", "-m", "init");

		const env = new NodeExecutionEnv({ cwd: directory });
		const workspace = new Workspace(env, [], 1);

		const diff = await workspace.getCheckpointDiff({ entryId: 1 }, context);
		assert.equal(diff.hasCheckpoint, false);
		assert.equal(diff.added, 0);
		assert.equal(diff.deleted, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("no checkpoint: undoToCheckpoint throws", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-checkpoint-no-undo-")));
	try {
		git(directory, "init", "-q");
		await writeFile(join(directory, "init.txt"), "hello\n");
		git(directory, "add", "init.txt");
		git(directory, "commit", "-q", "-m", "init");

		const env = new NodeExecutionEnv({ cwd: directory });
		const workspace = new Workspace(env, [], 1);

		await assert.rejects(workspace.undoToCheckpoint({ entryId: 1 }, context), /No checkpoint found for undo/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("checkpoint survives re-read from git ref (simulated restart)", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "p2-checkpoint-restart-")));
	try {
		git(directory, "init", "-q");
		const file = join(directory, "index.ts");
		await writeFile(file, "line1\nline2\nline3\n");
		git(directory, "add", "index.ts");
		git(directory, "commit", "-q", "-m", "init");

		const env = new NodeExecutionEnv({ cwd: directory });
		const workspace = new Workspace(env, [], 1);

		// Create checkpoint in one workspace instance
		await workspace.createCheckpoint(1, context);

		// Agent edits the file
		await writeFile(file, "line1\nchanged\nline3\n");

		// New workspace instance simulates worker restart: in-memory map is empty,
		// but the ref persists in git so findCheckpoint reads it back.
		const workspace2 = new Workspace(env, [], 1);
		const diff = await workspace2.getCheckpointDiff({ entryId: 1 }, context);
		assert.equal(diff.hasCheckpoint, true);
		assert.equal(diff.deleted, 1, "one line was changed after checkpoint");

		const undoResult = await workspace2.undoToCheckpoint({ entryId: 1 }, context);
		assert.ok(undoResult.revertId);

		const contentAfterUndo = await readFile(file, "utf8");
		assert.equal(contentAfterUndo, "line1\nline2\nline3\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
