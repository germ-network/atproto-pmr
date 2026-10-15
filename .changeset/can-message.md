---
"@germ-network/atproto-pmr-core": patch
"@germ-network/atproto-pmr-monitor-cloudflare": patch
---

Add the "can A message B?" verdict: `GET /pmr/v1/can-message/{sender}/{recipient}` (`handleCanMessageRead`) answers `yes`, `no` or `unknown` for one pair, computed from the recipient's declared allow policies and the Bluesky graph. It serves a verdict, never a follow or block list; a Bluesky block vetoes every policy, and missing graph data reads as `unknown`, not `no`.

The recipient's policy is the `AnchorPolicy` in its declaration's keyPackage (`readAnchorPolicy`, `declaredPoliciesOf`). The KV snapshot of a verified declaration now carries its decoded policies in metadata (optional; older entries are read from the CAR). `computeCanMessage` / `computeCanMessageMany` take a `PolicySource` and a batched `SenderGraphReader`; monitor-cloudflare adds `d1SenderGraphReader` and `BlockEdgeStore.blockersOf`. The route is mounted by the deploying Worker.
