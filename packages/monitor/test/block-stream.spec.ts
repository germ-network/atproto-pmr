/** Block commits on the follow/profile stream, routed by the keep rule. */
import { describe, it } from "vitest"

describe("routeFollowEvent — blocks", () => {
    it.todo("keeps every block create by a graph owner")
    it.todo("keeps a block create by a non-owner in interest only when its subject is registered")
    it.todo("drops a block create by a DID outside interest")
    it.todo("keeps a block delete when the blocker is in interest, logged as a block op")
    it.todo("drops a block create with no subject")
})
