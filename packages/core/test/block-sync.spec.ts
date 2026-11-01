/**
 * Every catch-up first mirrors the owner's current Bsky blocks, so mail from a
 * sender blocked since it was accepted is cleared rather than delivered — and
 * a block the relay cannot see is never lifted.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BlockEdge } from "../src/block-edges"
import { BLOCK_SYNC_DEADLINE_MS, syncOwnerBlocks } from "../src/block-sync"
import { drainBacklog } from "../src/events"
import { handleMessagesList, handlePoolList } from "../src/owner/endpoints"
import type { PMRStore } from "../src/storage"
import { ownerWorld, OWNER } from "./owner-harness"

const edge = (subject: string): BlockEdge => ({ blocker: OWNER, rkey: subject, subject })

function recordingStore(log: string[] = []) {
    const synced: Array<ReadonlySet<string>> = []
    const store = {
        load: async () => ({ did: OWNER }),
        syncBskyBlocks: async (set: ReadonlySet<string>) => {
            log.push("sync")
            synced.push(set)
        },
        unblock: async () => {
            log.push("unblock")
        },
        openMailboxes: async () => {
            log.push("openMailboxes")
            return { entries: [], nextCursor: null }
        },
        poolSenders: async () => {
            log.push("poolSenders")
            return []
        },
    } as unknown as PMRStore
    return { store, synced, log }
}

describe("syncOwnerBlocks", () => {
    it("passes the subjects of the owner's ownBlocks to syncBskyBlocks", async () => {
        const { store, synced } = recordingStore()
        const asked: string[] = []
        await syncOwnerBlocks(store, OWNER, {
            ownBlocks: async (did) => {
                asked.push(did)
                return [edge("did:plc:a"), edge("did:plc:b")]
            },
        })
        expect(asked).toEqual([OWNER])
        expect(synced).toEqual([new Set(["did:plc:a", "did:plc:b"])])
    })

    it("skips subjects that are not DIDs or exceed the storage key limit", async () => {
        const { store, synced } = recordingStore()
        await syncOwnerBlocks(store, OWNER, {
            ownBlocks: async () => [
                edge("did:plc:ok"),
                edge("not-a-did"),
                edge("did:web:" + "x".repeat(2100)),
            ],
        })
        expect(synced).toEqual([new Set(["did:plc:ok"])])
    })

    it("a block row that leaves ownBlocks reaches the store only as a smaller set, never as an unblock", async () => {
        const { store, synced, log } = recordingStore()
        let edges = [edge("did:plc:a"), edge("did:plc:b")]
        const source = { ownBlocks: async () => edges }
        await syncOwnerBlocks(store, OWNER, source)
        edges = [edge("did:plc:a")]
        await syncOwnerBlocks(store, OWNER, source)
        expect(synced).toEqual([new Set(["did:plc:a", "did:plc:b"]), new Set(["did:plc:a"])])
        expect(log).not.toContain("unblock")
    })

    it("does nothing without a blocks source", async () => {
        const { store, synced } = recordingStore()
        await syncOwnerBlocks(store, OWNER, undefined)
        expect(synced).toEqual([])
    })

    it("does nothing when the owner's graph is not served (ownBlocks null)", async () => {
        const { store, synced } = recordingStore()
        await syncOwnerBlocks(store, OWNER, { ownBlocks: async () => null })
        expect(synced).toEqual([])
    })

    it("does nothing and does not throw when ownBlocks throws", async () => {
        const { store, synced } = recordingStore()
        await syncOwnerBlocks(store, OWNER, {
            ownBlocks: async () => {
                throw new Error("monitor down")
            },
        })
        expect(synced).toEqual([])
    })

    it("treats a read slower than the deadline as a failed one", async () => {
        vi.useFakeTimers()
        const { store, synced } = recordingStore()
        const pending = syncOwnerBlocks(store, OWNER, { ownBlocks: () => new Promise(() => {}) })
        await vi.advanceTimersByTimeAsync(BLOCK_SYNC_DEADLINE_MS)
        await pending
        expect(synced).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
    })

    it("clears its deadline timer once the read settles", async () => {
        vi.useFakeTimers()
        const { store } = recordingStore()
        await syncOwnerBlocks(store, OWNER, { ownBlocks: async () => [] })
        expect(vi.getTimerCount()).toBe(0)
    })

    it("does not throw when the store's sync fails", async () => {
        const store = {
            syncBskyBlocks: async () => {
                throw new Error("storage")
            },
        } as unknown as PMRStore
        await syncOwnerBlocks(store, OWNER, { ownBlocks: async () => [] })
    })
})

const asked: string[] = []
const blocks = {
    ownBlocks: async (did: string) => {
        asked.push(did)
        return [edge("did:plc:a")]
    },
}
afterEach(() => {
    asked.length = 0
    vi.useRealTimers()
})

describe("catch-up mirrors blocks first", () => {
    it("drainBacklog syncs before reading any mailbox, so a newly blocked sender's queue is not delivered", async () => {
        const { store, log } = recordingStore()
        await drainBacklog(
            { store, bodies: {} as never, blocks },
            {} as never,
            () => {}
        ).catch(() => {})
        expect(log.slice(0, 2)).toEqual(["sync", "openMailboxes"])
        expect(asked).toEqual([OWNER])
    })

    it("drainBacklog still drains when loading the registration fails", async () => {
        const { store, log, synced } = recordingStore()
        store.load = async () => {
            throw new Error("storage")
        }
        await drainBacklog({ store, bodies: {} as never, blocks }, {} as never, () => {}).catch(() => {})
        expect(synced).toEqual([])
        expect(log).toContain("openMailboxes")
    })

    it("drainBacklog reads the owner DID from the store and still drains when it cannot", async () => {
        const { store, log, synced } = recordingStore()
        store.load = async () => null
        await drainBacklog({ store, bodies: {} as never, blocks }, {} as never, () => {}).catch(() => {})
        expect(synced).toEqual([])
        expect(log).toContain("openMailboxes")
    })

    it("GET /pmr/v1/messages syncs on the first page only (no cursor or an empty one)", async () => {
        const log: string[] = []
        const { store } = recordingStore(log)
        const w = await ownerWorld(store, { blocks, bodies: {} as never, catchUpPageMailboxes: 2 } as never)
        const list = async (path: string) =>
            handleMessagesList(await w.request(path), w.deps as never)
        await list("/pmr/v1/messages")
        await list("/pmr/v1/messages?cursor=")
        expect(log.filter((e) => e === "sync")).toHaveLength(2)
        expect(asked).toEqual([OWNER, OWNER])
        log.length = 0
        await list("/pmr/v1/messages?cursor=did:plc:x")
        expect(log).toEqual(["openMailboxes"])
    })

    it("GET /pmr/v1/pool syncs before listing, so a bsky-blocked pooled sender is not listed", async () => {
        const log: string[] = []
        const { store } = recordingStore(log)
        const w = await ownerWorld(store, { blocks })
        await handlePoolList(await w.request("/pmr/v1/pool"), w.deps)
        expect(log).toEqual(["sync", "poolSenders"])
        expect(asked).toEqual([OWNER])
    })
})
