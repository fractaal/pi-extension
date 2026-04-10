import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
		environment: "node",
		clearMocks: true,
		restoreMocks: true,
		mockReset: true,
	},
});
