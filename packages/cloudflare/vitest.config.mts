import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.test.toml" },
        }),
    ],
    test: {
        include: ["test/**/*.spec.ts"],
        coverage: {
            provider: "istanbul",
            include: ["src/**/*.ts"],
            reporter: ["text-summary", "json-summary"],
        },
    },
})
