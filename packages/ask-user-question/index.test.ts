import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import askUserQuestionExtension from "./index.ts";

describe("ask-user-question extension", () => {
	it("returns an error for an empty question", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const result = await execute("call-1", { question: "   " }, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			isError: true,
			details: { cancelled: true, question: "" },
		});
	});

	it("returns the selected option for single-choice prompts", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const notify = vi.fn();
		const select = vi.fn(async () => "Alpha");
		const result = await execute("call-2", { question: "Pick one", options: ["Alpha", "Beta"] }, undefined, undefined, {
			hasUI: true,
			ui: { notify, select },
		} as unknown as ExtensionContext);

		expect(notify).toHaveBeenCalledWith("Waiting for input", "info");
		expect(select).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Alpha" }],
			details: {
				answer: "Alpha",
				answers: ["Alpha"],
				selectedIndex: 1,
				selectedOption: "Alpha",
			},
		});
	});

	it("supports multi-select answers with custom input", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const selections = ["☐ 1. Alpha", "Other (type your own)", "Done selecting (2 selected)"];
		const select = vi.fn(async () => selections.shift());
		const input = vi.fn(async () => "Custom");
		const result = await execute(
			"call-3",
			{ question: "Pick many", options: ["Alpha", "Beta"], allowMultiple: true },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { notify: vi.fn(), select, input },
			} as unknown as ExtensionContext,
		);

		expect(input).toHaveBeenCalledWith("Your answer", "");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Alpha, Custom" }],
			details: {
				answers: ["Alpha", "Custom"],
				selectedIndices: [1],
				customInput: "Custom",
			},
		});
	});
});
