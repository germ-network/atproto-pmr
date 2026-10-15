/**
 * A device read of a lapsed declaration reorders the refresh queue without
 * making anything due that was not, and without letting anonymous reads
 * pin failing sources at the head.
 */
import { describe, it } from "vitest"

describe("MonitorIngest.requestRefresh", () => {
    it.todo("a requested DID that is due comes ahead of due DIDs not requested")
    it.todo("a request for a DID confirmed since its bound changes nothing")
    it.todo("a request for a DID attempted since its bound changes nothing")
    it.todo("requested DIDs fill at most a quarter of a batch, the rest in the usual order")
    it.todo("a batch under four still takes one requested DID")
    it.todo("repeated requests for one DID yield it once")
    it.todo("dueRefresh returning a DID clears its request")
    it.todo("a request for a DID outside the interest set changes nothing")
    it.todo("a DID leaving interest has its request deleted")
    it.todo("a request a day old is dropped without selection")
})
