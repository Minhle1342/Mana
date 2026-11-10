import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execCommand } from "./exec.ts";

const CHECKPOINT_EXCLUDE_PATHSPECS = [
	":(exclude).p2-test-data",
	":(exclude)apps/p2/.p2-test-data",
	":(exclude)*.sqlite",
	":(exclude)*.sqlite-shm",
	":(exclude)*.sqlite-wal",
	":(exclude)pi_tmp_idx_*",
];

const CLEAN_EXCLUDE_ARGS = [
	"-e",
	".p2-test-data",
	"-e",
	"apps/p2/.p2-test-data",
	"-e",
	"*.sqlite*",
	"-e",
	"pi_tmp_idx_*",
];

export interface CheckpointDiffResult {
	hasCheckpoint: boolean;
	added: number;
	deleted: number;
}

export interface CheckpointUndoResult {
	revertId: string;
	revertAdded: number;
	revertDeleted: number;
}

export interface CheckpointRevertResult {
	success: boolean;
}

export class CheckpointManager {
	readonly cwd: string;
	readonly sessionId: string;
	private readonly checkpoints: Map<string, string>;
	private readonly checkpointOrder: string[];
	private readonly reverts: Map<string, string>;
	private latestRevertId: string | undefined;

	constructor(cwd: string, sessionId: string) {
		this.cwd = cwd;
		this.sessionId = sessionId;
		this.checkpoints = new Map();
		this.checkpointOrder = [];
		this.reverts = new Map();
		this.latestRevertId = undefined;
	}

	private sanitizeId(id: string): string {
		return id.replace(/[^a-zA-Z0-9._-]/g, "_");
	}

	private checkpointRefNamespace(): string {
		return `refs/pi/checkpoints/${this.sanitizeId(this.sessionId)}`;
	}

	private revertRefNamespace(): string {
		return `refs/pi/reverts/${this.sanitizeId(this.sessionId)}`;
	}

	private async git(
		args: string[],
		extraEnv?: NodeJS.ProcessEnv,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		const result = await execCommand("git", args, this.cwd, {
			env: extraEnv,
			timeout: 30000,
		});
		return { code: result.code, stdout: result.stdout, stderr: result.stderr };
	}

	async isInsideWorkTree(): Promise<boolean> {
		const { code } = await this.git(["rev-parse", "--is-inside-work-tree"]);
		return code === 0;
	}

	async createSnapshot(message: string): Promise<string> {
		const isGit = await this.isInsideWorkTree();
		if (!isGit) throw new Error("Not inside a git worktree");

		const gitDirRun = await this.git(["rev-parse", "--git-dir"]);
		const gitDir = gitDirRun.code === 0 && gitDirRun.stdout.trim() ? gitDirRun.stdout.trim() : ".git";
		const tempIndex = isAbsolute(gitDir)
			? join(gitDir, `pi_tmp_idx_${Date.now()}_${Math.random().toString(36).slice(2)}`)
			: join(this.cwd, gitDir, `pi_tmp_idx_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		const extraEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndex };

		const head = await this.git(["rev-parse", "HEAD"]);
		const headRef = head.code === 0 ? head.stdout.trim() : undefined;

		try {
			if (headRef) {
				await this.git(["read-tree", headRef], extraEnv);
			}
			await this.git(["add", "-A"], extraEnv);
			const writeTree = await this.git(["write-tree"], extraEnv);
			if (writeTree.code !== 0) {
				throw new Error(`write-tree failed: ${writeTree.stderr || writeTree.stdout}`);
			}

			const tree = writeTree.stdout.trim();
			const commitArgs = ["commit-tree", tree];
			if (headRef) {
				commitArgs.push("-p", headRef);
			}
			commitArgs.push("-m", message);
			const commitRun = await this.git(commitArgs, extraEnv);
			if (commitRun.code !== 0) {
				throw new Error(`commit-tree failed: ${commitRun.stderr || commitRun.stdout}`);
			}
			return commitRun.stdout.trim();
		} finally {
			try {
				rmSync(tempIndex, { force: true });
			} catch {}
		}
	}

	async createCheckpoint(turnId: string | number): Promise<string | null> {
		const isGit = await this.isInsideWorkTree();
		if (!isGit) return null;

		const idStr = String(turnId);
		const commitSha = await this.createSnapshot(`checkpoint_${idStr}`);
		this.checkpoints.set(idStr, commitSha);
		if (!this.checkpointOrder.includes(idStr)) {
			this.checkpointOrder.push(idStr);
		}

		const refName = `${this.checkpointRefNamespace()}/${idStr}`;
		const run = await this.git(["update-ref", refName, commitSha]);
		if (run.code !== 0) {
			throw new Error(`update-ref failed: ${run.stderr || run.stdout}`);
		}
		return commitSha;
	}

	private async readCheckpointRef(turnId: string): Promise<string | undefined> {
		const run = await this.git(["rev-parse", "-q", "--verify", `${this.checkpointRefNamespace()}/${turnId}`]);
		if (run.code === 0 && run.stdout.trim().length > 0) {
			return run.stdout.trim();
		}
		return undefined;
	}

	private async readAllCheckpointRefs(): Promise<void> {
		const run = await this.git([
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			`${this.checkpointRefNamespace()}/`,
		]);
		if (run.code !== 0) return;
		const prefix = `${this.checkpointRefNamespace()}/`;
		const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
		for (const line of lines) {
			const parts = line.trim().split(" ");
			if (parts.length >= 2) {
				const refname = parts[0] ?? "";
				const sha = parts[1] ?? "";
				if (refname.startsWith(prefix)) {
					const id = refname.slice(prefix.length);
					if (id && sha) {
						this.checkpoints.set(id, sha);
						if (!this.checkpointOrder.includes(id)) {
							this.checkpointOrder.push(id);
						}
					}
				}
			}
		}
	}

	async findCheckpoint(turnId?: string | number): Promise<{ turnId: string; commitSha: string } | undefined> {
		if (turnId !== undefined) {
			const idStr = String(turnId);
			if (this.checkpoints.has(idStr)) {
				return { turnId: idStr, commitSha: this.checkpoints.get(idStr)! };
			}
			const ref = await this.readCheckpointRef(idStr);
			if (ref) {
				this.checkpoints.set(idStr, ref);
				if (!this.checkpointOrder.includes(idStr)) {
					this.checkpointOrder.push(idStr);
				}
				return { turnId: idStr, commitSha: ref };
			}
			return undefined;
		}

		if (this.checkpointOrder.length > 0) {
			const latestId = this.checkpointOrder[this.checkpointOrder.length - 1]!;
			const commitSha = this.checkpoints.get(latestId);
			if (commitSha) return { turnId: latestId, commitSha };
		}

		await this.readAllCheckpointRefs();
		if (this.checkpointOrder.length > 0) {
			const latestId = this.checkpointOrder[this.checkpointOrder.length - 1]!;
			const commitSha = this.checkpoints.get(latestId);
			if (commitSha) return { turnId: latestId, commitSha };
		}

		return undefined;
	}

	async getCheckpointDiff(turnId?: string | number): Promise<CheckpointDiffResult> {
		const isGit = await this.isInsideWorkTree();
		if (!isGit) return { hasCheckpoint: false, added: 0, deleted: 0 };

		const cp = await this.findCheckpoint(turnId);
		if (!cp) return { hasCheckpoint: false, added: 0, deleted: 0 };

		const currentRef = await this.createSnapshot("temp_diff_check");
		const run = await this.git([
			"diff",
			"--numstat",
			"--no-color",
			"--ignore-submodules=dirty",
			cp.commitSha,
			currentRef,
			"--",
			".",
			...CHECKPOINT_EXCLUDE_PATHSPECS,
		]);

		let addedLines = 0;
		let deletedLines = 0;
		if (run.code === 0) {
			const lines = run.stdout.split("\n").filter((l) => l.trim().length > 0);
			for (const line of lines) {
				const parts = line.split("\t");
				if (parts.length >= 2) {
					const add = Number.parseInt(parts[0] ?? "0", 10);
					const del = Number.parseInt(parts[1] ?? "0", 10);
					if (!Number.isNaN(add)) addedLines += add;
					if (!Number.isNaN(del)) deletedLines += del;
				}
			}
		}

		return {
			hasCheckpoint: true,
			added: deletedLines,
			deleted: addedLines,
		};
	}

	async undoToCheckpoint(turnId?: string | number): Promise<CheckpointUndoResult> {
		const cp = await this.findCheckpoint(turnId);
		if (!cp) throw new Error("No checkpoint found for undo");

		const revertRef = await this.createSnapshot(`revert_snapshot_${Date.now()}`);

		const diff = await this.git([
			"diff",
			"--numstat",
			"--no-color",
			"--ignore-submodules=dirty",
			cp.commitSha,
			revertRef,
			"--",
			".",
			...CHECKPOINT_EXCLUDE_PATHSPECS,
		]);

		let revertAdded = 0;
		let revertDeleted = 0;
		if (diff.code === 0) {
			const lines = diff.stdout.split("\n").filter((l) => l.trim().length > 0);
			for (const line of lines) {
				const parts = line.split("\t");
				if (parts.length >= 2) {
					const add = Number.parseInt(parts[0] ?? "0", 10);
					const del = Number.parseInt(parts[1] ?? "0", 10);
					if (!Number.isNaN(add)) revertAdded += add;
					if (!Number.isNaN(del)) revertDeleted += del;
				}
			}
		}

		const checkout = await this.git(["checkout", cp.commitSha, "--", ".", ...CHECKPOINT_EXCLUDE_PATHSPECS]);
		if (checkout.code !== 0) {
			throw new Error(`checkout failed: ${checkout.stderr || checkout.stdout}`);
		}

		const clean = await this.git(["clean", "-fd", ...CLEAN_EXCLUDE_ARGS]);
		if (clean.code !== 0) {
			throw new Error(`clean failed: ${clean.stderr || clean.stdout}`);
		}

		const revertId = `revert_${Date.now()}`;
		this.reverts.set(revertId, revertRef);
		this.latestRevertId = revertId;

		const run = await this.git(["update-ref", `${this.revertRefNamespace()}/${revertId}`, revertRef]);
		if (run.code !== 0) {
			throw new Error(`update-ref failed: ${run.stderr || run.stdout}`);
		}

		return { revertId, revertAdded, revertDeleted };
	}

	private async readRevertRef(revertId: string): Promise<string | undefined> {
		const run = await this.git(["rev-parse", "-q", "--verify", `${this.revertRefNamespace()}/${revertId}`]);
		if (run.code === 0 && run.stdout.trim().length > 0) {
			return run.stdout.trim();
		}
		return undefined;
	}

	async revertUndo(revertId?: string): Promise<CheckpointRevertResult> {
		const targetId = revertId ?? this.latestRevertId;
		if (!targetId) throw new Error("No active revert found");

		let revertRef = this.reverts.get(targetId);
		if (!revertRef) {
			revertRef = await this.readRevertRef(targetId);
			if (!revertRef) throw new Error("No active revert found");
			this.reverts.set(targetId, revertRef);
		}

		const checkout = await this.git(["checkout", revertRef, "--", ".", ...CHECKPOINT_EXCLUDE_PATHSPECS]);
		if (checkout.code !== 0) {
			throw new Error(`checkout failed: ${checkout.stderr || checkout.stdout}`);
		}

		this.reverts.delete(targetId);
		if (this.latestRevertId === targetId) {
			this.latestRevertId = undefined;
		}

		await this.git(["update-ref", "-d", `${this.revertRefNamespace()}/${targetId}`]).catch(() => {});
		return { success: true };
	}

	async dismissRevert(revertId?: string): Promise<CheckpointRevertResult> {
		const targetId = revertId ?? this.latestRevertId;
		if (!targetId) return { success: true };

		this.reverts.delete(targetId);
		if (this.latestRevertId === targetId) {
			this.latestRevertId = undefined;
		}

		await this.git(["update-ref", "-d", `${this.revertRefNamespace()}/${targetId}`]).catch(() => {});
		return { success: true };
	}
}
