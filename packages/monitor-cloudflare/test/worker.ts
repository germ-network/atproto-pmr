/** Entry point for the test runner: wrangler finds the classes here. */
import type { InterestPolicy } from "@germ-network/atproto-pmr-core"
import { MonitorIngest } from "../src/ingest-object"

export { MonitorIngest }

/** The ingest object under the `registered` policy, whatever `INTEREST_POLICY` says. */
export class RegisteredMonitorIngest extends MonitorIngest {
    override interestPolicy(): InterestPolicy {
        return "registered"
    }
}

export default { fetch: () => new Response(null, { status: 404 }) }
