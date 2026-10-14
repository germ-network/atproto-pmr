import { applyD1Migrations, env } from "cloudflare:test"

const testEnv = env as unknown as {
    graph: D1Database
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1]
}
await applyD1Migrations(testEnv.graph, testEnv.TEST_MIGRATIONS)
