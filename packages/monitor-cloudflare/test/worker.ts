/** Entry point for the test runner: wrangler finds the class here. */
export { MonitorIngest } from "../src/ingest-object"
export default { fetch: () => new Response(null, { status: 404 }) }
