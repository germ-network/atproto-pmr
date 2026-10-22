/**
 * RecordNotFound no longer marks a DID permanently gone: only a gone repo
 * (RepoNotFound, a PLC tombstone) does. DIDs marked gone before that rule
 * are asked once more; only a revival is announced.
 */
import { describe, it } from "vitest"

describe("a reversible answer lifts a permanent mark", () => {
    it.todo("a reversible gone answer for a DID with a deleted row drops the row and leaves it gone-reversible")
    it.todo("a gone-reversible DID is a refresh candidate again under everyone")
    it.todo("a permanent answer still writes the deleted row and gone-permanent")
    it.todo("a DID downgraded from deleted to gone-reversible by a pending settle, and left unwatched, has its stored DID document marked stale")
    it.todo("a downgraded DID that stays watched keeps its stored DID document confirmed")
    it.todo("under registered, a downgraded did:plc interest member is owed its plc log again")
    it.todo("a held DID answered RecordNotFound, then republished, is held again through dueRefresh and refresh with no firehose commit")
})

describe("the one-time re-owe of DIDs marked deleted before the upgrade", () => {
    it.todo("every deleted DID is owed once, behind live owes, and the seed never runs twice across evictions")
    it.todo("a deleted DID with a live record at its indexed rev is held again, announced with a window entry and onChange, and its deleted row is gone")
    it.todo("a deleted DID answering RecordNotFound becomes gone-reversible with no window entry and no onDelete")
    it.todo("a deleted DID answering with a signed exclusion proof becomes gone-reversible, cause record, and verifiedAnchorOf answers absent")
    it.todo("a deleted DID answering RepoNotFound stays deleted and gone-permanent")
    it.todo("an existing pending row for a deleted DID keeps its rev and backoff but is made non-quiet")
})
