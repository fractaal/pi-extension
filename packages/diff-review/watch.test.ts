import { describe, expect, it } from "vitest";
import { __testing } from "./watch.ts";

describe("diff-review change watcher helpers", () => {
	it("ignores noisy dependency and VCS paths", () => {
		expect(__testing.isIgnoredWatchPath(".git/index")).toBe(true);
		expect(__testing.isIgnoredWatchPath("node_modules/pkg/index.js")).toBe(true);
		expect(__testing.isIgnoredWatchPath("apps/web/.next/cache/file")).toBe(true);
		expect(__testing.isIgnoredWatchPath("coverage/report/index.html")).toBe(true);
	});

	it("keeps source paths reviewable", () => {
		expect(__testing.isIgnoredWatchPath("src/index.ts")).toBe(false);
		expect(__testing.isIgnoredWatchPath("packages/diff-review/web/app.js")).toBe(false);
		expect(__testing.isIgnoredWatchPath(null)).toBe(false);
	});

	it("ignores common editor and OS temp files", () => {
		expect(__testing.isIgnoredWatchPath("src/file.ts.swp")).toBe(true);
		expect(__testing.isIgnoredWatchPath("src/file.ts~")).toBe(true);
		expect(__testing.isIgnoredWatchPath(".DS_Store")).toBe(true);
	});
});
