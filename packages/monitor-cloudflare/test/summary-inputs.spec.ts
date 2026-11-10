/**
 * Every committed declaration change and graph write reports its summary
 * inputs once, after the commit, and a failing report harms nothing.
 */
import { describe, it } from "vitest"

describe("summary input tracking writer", () => {
    it.todo("putEdges reports both endpoints of each inserted edge as owners after the rows commit")
    it.todo("putEdges reports a re-pointed follow's follower, old subject and new subject as owners")
    it.todo("putEdges rewriting edges unchanged, as a relist does, reports nothing")
    it.todo("deleteEdges reports each deleted edge's follower and subject as owners")
    it.todo("deleteEdges of edges that do not exist reports nothing")
    it.todo("sweep reports the follower and the swept subjects as owners")
    it.todo("mirror reports each transition's DID as a changed DID and pruned subjects as owners, after the mirror rows commit")
    it.todo("a write that changed nothing reports nothing")
    it.todo("a report that throws does not fail the write or the step's bookkeeping")
})

describe("MonitorIngest.onSummaryInputsChanged", () => {
    it.todo("a declaration change reports its DID after the new state is stored")
    it.todo("a declaration deletion reports its DID")
    it.todo("a quiet re-verify that stores the same declaration reports nothing")
    it.todo("a deployment onChange override that throws or does not call super still reports")
    it.todo("leaving interest reports the DID")
    it.todo("the alarm's graph steps report a mirrored holder transition")
    it.todo("the alarm's listing step reports the listed follower and its subjects")
    it.todo("the alarm's edge flush reports the flushed edges' endpoints")
    it.todo("a throwing hook does not stop the alarm's later graph steps")
})
