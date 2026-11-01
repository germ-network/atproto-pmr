import type { FirehoseCoverage } from "@germ-network/atproto-pmr-core"
import type { MonitorEnv } from "./env"
import type { MonitorIngest } from "./ingest-object"

/** One value, watermark and lagging list together: KV has no cross-key atomicity. */
export const FIREHOSE_COVERAGE_KEY = "firehose:coverage"

function parseFirehoseCoverage(text: string | null): FirehoseCoverage | null {
    if (text === null) return null
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return null
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const { continuousSinceMs, coveredThroughMs, lagging } = value as Record<string, unknown>
    if (typeof continuousSinceMs !== "number" || !Number.isFinite(continuousSinceMs)) return null
    if (
        coveredThroughMs !== null &&
        (typeof coveredThroughMs !== "number" || !Number.isFinite(coveredThroughMs))
    ) {
        return null
    }
    if (!Array.isArray(lagging) || !lagging.every((d) => typeof d === "string")) return null
    return { continuousSinceMs, coveredThroughMs, lagging }
}

/** The relay's read of `firehose:coverage`. A missing or malformed entry reads as none. */
export function kvFirehoseCoverage<TIngest extends MonitorIngest = MonitorIngest>(
    env: MonitorEnv<TIngest>
): () => Promise<FirehoseCoverage | null> {
    return async () => parseFirehoseCoverage(await env.records.get(FIREHOSE_COVERAGE_KEY))
}
