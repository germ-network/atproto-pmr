/** Test-only entry so wrangler can find the Durable Object class. */
export { PMRObject } from "../src/pmr-object"

export default {
    async fetch(): Promise<Response> {
        return new Response("test worker", { status: 200 })
    },
}
