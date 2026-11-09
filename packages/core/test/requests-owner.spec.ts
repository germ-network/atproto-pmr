/**
 * GET /pmr/v1/requests lists request mailboxes by DID and entry ids, so the
 * device judges a sender before downloading anything.
 */
import { describe, it } from "vitest"

describe("handleRequestsList", () => {
    it.todo("answers {rq: [{k, id}], n} from requestMailboxes, ids oldest first")
    it.todo("carries no relay verdict or reason on a row")
    it.todo("passes the cursor through and pages by catchUpPageMailboxes")
    it.todo("mirrors the owner's Bsky blocks before the first page (no cursor or an empty one) and not on later pages")
    it.todo("refuses an unauthenticated request like any owner endpoint")
})
