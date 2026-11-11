import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TabLayout, TabStateStore } from "../src/core/tab-state.ts";

const layout: TabLayout = {
	tabs: [
		{ name: "Tab 1", customName: false, cwd: "/work/one", sessionFile: "/sessions/one.jsonl" },
		{ name: "Docs", customName: true, cwd: "/work/two", sessionFile: null },
	],
	activeIndex: 1,
};

const agentDirs: string[] = [];

async function makeStore(): Promise<{ store: TabStateStore; agentDir: string }> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-tabs-"));
	agentDirs.push(agentDir);
	return { store: new TabStateStore(agentDir), agentDir };
}

afterEach(async () => {
	vi.useRealTimers();
	for (const agentDir of agentDirs.splice(0)) {
		await rm(agentDir, { recursive: true, force: true });
	}
});

describe("TabStateStore", () => {
	it("round-trips a workspace layout", async () => {
		const { store } = await makeStore();
		expect(store.load("/work/one")).toBeUndefined();
		store.save("/work/one", layout);
		const loaded = store.load("/work/one");
		expect(loaded?.tabs).toEqual(layout.tabs);
		expect(loaded?.activeIndex).toBe(1);
		expect(typeof loaded?.updatedAt).toBe("string");
	});

	it("returns undefined for a workspace that was never saved", async () => {
		const { store } = await makeStore();
		store.save("/work/one", layout);
		expect(store.load("/work/other")).toBeUndefined();
	});

	it("treats invalid JSON, an unknown version, and malformed entries as no saved tabs", async () => {
		const { store, agentDir } = await makeStore();
		const path = join(agentDir, "tabs.json");

		await writeFile(path, "not json", "utf-8");
		expect(store.load("/work/one")).toBeUndefined();

		await writeFile(path, JSON.stringify({ version: 2, workspaces: { "/work/one": layout } }), "utf-8");
		expect(store.load("/work/one")).toBeUndefined();

		await writeFile(
			path,
			JSON.stringify({ version: 1, workspaces: { "/work/one": { tabs: [{ name: 1 }], activeIndex: 0 } } }),
			"utf-8",
		);
		expect(store.load("/work/one")).toBeUndefined();
	});

	it("replaces a corrupt file with a valid one on the next save", async () => {
		const { store, agentDir } = await makeStore();
		await writeFile(join(agentDir, "tabs.json"), "{ broken", "utf-8");
		store.save("/work/one", layout);
		expect(store.load("/work/one")?.tabs).toEqual(layout.tabs);
	});

	it("leaves a file from an unknown version untouched", async () => {
		const { store, agentDir } = await makeStore();
		const path = join(agentDir, "tabs.json");
		const future = JSON.stringify({ version: 2, workspaces: { "/work/one": layout } });
		await writeFile(path, future, "utf-8");

		store.save("/work/two", layout);

		expect(await readFile(path, "utf-8")).toBe(future);
		expect(store.load("/work/one")).toBeUndefined();
	});

	it("keys one record per workspace across separators and casing", async () => {
		const { store, agentDir } = await makeStore();
		store.save("/work/one", layout);
		store.save("/work/one/", { ...layout, activeIndex: 0 });
		const file = JSON.parse(await readFile(join(agentDir, "tabs.json"), "utf-8"));
		expect(Object.keys(file.workspaces)).toHaveLength(1);
		// Case folds only where the platform does; elsewhere a differently-cased path is another workspace.
		expect(store.load("/work/ONE")?.activeIndex).toBe(process.platform === "win32" ? 0 : undefined);
	});

	it("prunes to the 32 most recently saved workspaces", async () => {
		const { store, agentDir } = await makeStore();
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		vi.useFakeTimers();
		for (let index = 0; index < 40; index++) {
			vi.setSystemTime(new Date(base + index * 1000));
			store.save(`/work/${index}`, layout);
		}
		vi.useRealTimers();

		const file = JSON.parse(await readFile(join(agentDir, "tabs.json"), "utf-8"));
		const keys = Object.keys(file.workspaces);
		expect(keys).toHaveLength(32);
		expect(store.load("/work/39")).toBeDefined();
		expect(store.load("/work/0")).toBeUndefined();
	});
});
