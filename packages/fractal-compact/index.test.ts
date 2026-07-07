import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import fractalCompactExtension from "./index.ts";

type EventBusMock = {
	emits: Array<{ name: string; data: unknown }>;
};

function installEventBus(api: { api: unknown }): EventBusMock {
	const eventBus: EventBusMock = { emits: [] };
	Object.assign(api.api as object, {
		events: {
			emit(name: string, data: unknown) {
				eventBus.emits.push({ name, data });
			},
		},
	});
	return eventBus;
}

describe("fractal compact extension", () => {
	it("registers compaction hooks", () => {
		const apiMock = createExtensionApiMock();
		fractalCompactExtension(apiMock.api);

		expect(apiMock.getHandlers("session_before_compact")).toHaveLength(1);
		expect(apiMock.getHandlers("session_compact")).toHaveLength(1);
	});

	it("emits ALR-compatible compaction status events", async () => {
		const apiMock = createExtensionApiMock();
		const events = installEventBus(apiMock);
		fractalCompactExtension(apiMock.api);

		const before = apiMock.getHandlers("session_before_compact")[0];
		const compact = apiMock.getHandlers("session_compact")[0];
		if (!before || !compact) throw new Error("compaction hooks missing");

		const notify = () => undefined;
		const setStatus = () => undefined;
		const result = await before(
			{
				signal: new AbortController().signal,
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					previousSummary: undefined,
					tokensBefore: 0,
					settings: { reserveTokens: 1000 },
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					firstKeptEntryId: "entry-1",
				},
			},
			{ hasUI: true, ui: { notify, setStatus } } as unknown as ExtensionContext,
		);
		await compact({}, { hasUI: true, ui: { notify, setStatus } } as unknown as ExtensionContext);

		expect(result).toEqual({ cancel: true });
		expect(events.emits).toEqual([
			{ name: "aria-local:compaction-update", data: { status: "running" } },
			{ name: "aria-local:compaction-update", data: { status: "completed" } },
		]);
	});
});
