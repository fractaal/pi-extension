import { describe, expect, it } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import codexUsageExtension from "./index.ts";

describe("codex usage info extension", () => {
	it("registers the same lifecycle hooks as the personal Pi hook", () => {
		const apiMock = createExtensionApiMock();
		codexUsageExtension(apiMock.api);

		expect(apiMock.getHandlers("session_start")).toHaveLength(1);
		expect(apiMock.getHandlers("session_tree")).toHaveLength(1);
		expect(apiMock.getHandlers("model_select")).toHaveLength(1);
		expect(apiMock.getHandlers("session_shutdown")).toHaveLength(1);
		expect(apiMock.tools.size).toBe(0);
		expect(apiMock.commands.size).toBe(0);
	});
});
