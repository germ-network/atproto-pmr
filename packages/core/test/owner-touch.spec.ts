/**
 * Owner activity at authentication: `authenticateOwner` touches the exact
 * authenticated registration once per UTC day, whatever the handler does next.
 */
import { describe, it } from "vitest"

describe("authenticateOwner touch", () => {
    it.todo("success touches once with the stored anchorKey blob")
    it.todo("success on a day already recorded makes no touchActive call")
    it.todo("each failed-auth reason never touches")
    it.todo("an authed() handler that answers 400, 404 or throws after auth has still touched")
    it.todo("a throwing touchActive leaves the auth result unchanged and the console silent")
    it.todo("touches the authenticated locator's store, never a re-resolved one")
})
