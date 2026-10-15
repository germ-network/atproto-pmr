/**
 * A pair put is judged by the recipient's receive-time admission and routed by
 * the store in one step, so devices receive what the recipient's policy admits
 * and judge the rest from the pool. Every outcome keeps the 202/429 vocabulary.
 */
import { describe, it } from "vitest"

describe("handlePairPut with admission", () => {
    it.todo("reads admission once, as (signed sender, recipient), and passes it to a single store.receive")
    it.todo("does not read admission for a 400, 413, 409, wrong-recipient or unknown-recipient put")
    it.todo("a queued outcome with persistBody stores the body, then delivers live and by push")
    it.todo("a queued outcome's moved entries are delivered live before the new message, with one push in all")
    it.todo("a queued outcome without persistBody stores and delivers nothing")
    it.todo("a pooled outcome with persistBody stores the body and delivers nothing")
    it.todo("refused answers 429 with Retry-After; queued, pooled, duplicate and exhausted answer 202")
    it.todo("a throwing or slow admission source passes unknown with admission-unavailable and never answers 5xx")
    it.todo("without an admission source, behaves as before: provisioned appends, everything else pools without a verdict")
})
