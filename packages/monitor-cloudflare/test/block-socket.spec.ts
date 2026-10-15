/** Live blocks from the follow/profile socket through to D1. */
import { describe, it } from "vitest"

describe("follow socket — blocks", () => {
    it.todo("subscribes the follow socket to the block collection")
    it.todo("flushes a kept block create and delete to the D1 blocks table")
    it.todo("queues no owner_followers re-count for a block write")
    it.todo("logs follow and block ops in one ordered edge_ops log")
    it.todo("a follow op and a block op sharing an rkey neither coalesce nor cancel")
    it.todo("a flush of mixed follow and block ops stays within the statement budget")
})
