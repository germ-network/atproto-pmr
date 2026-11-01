import { fetchRecordCar } from "../src/fetch-record"

const PDS = "https://pds.example"
const SIGNING_KEY = "zQ3shXjHeiBuRCKmM3rH6dHDW95NPMPsQC2z1eK7cyJmnhqfw"

/**
 * A `fetchRecord` that fails the way a PDS answering XRPC error `name`
 * does, built by the real fetcher so the error carries the real
 * `permanent` and `reason`.
 */
export const pdsAnswering =
    (name: string, collection: string) =>
    (did: string) =>
        fetchRecordCar(did, {
            collection,
            fetchImpl: (async (input: RequestInfo | URL) => {
                if (String(input).startsWith("https://plc.directory/")) {
                    return Response.json({
                        id: did,
                        service: [
                            {
                                id: "#atproto_pds",
                                type: "AtprotoPersonalDataServer",
                                serviceEndpoint: PDS,
                            },
                        ],
                        verificationMethod: [
                            {
                                id: `${did}#atproto`,
                                type: "Multikey",
                                controller: did,
                                publicKeyMultibase: SIGNING_KEY,
                            },
                        ],
                    })
                }
                return Response.json({ error: name, message: "gone" }, { status: 400 })
            }) as typeof fetch,
        })
