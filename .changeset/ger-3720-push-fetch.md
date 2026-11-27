---
"@germ-network/atproto-pmr-core": minor
"@germ-network/atproto-pmr-cloudflare": minor
"@germ-network/atproto-pmr-monitor": minor
"@germ-network/atproto-pmr-monitor-cloudflare": minor
---

Fix: in v0.9.0 and earlier, Web Push sent by the Cloudflare packages' senders did not leave the Worker. `deliverPush` called the injected `fetchImpl` as a method of its options object, and workerd throws "Illegal invocation" when its global `fetch` is called that way. `deliverPush` now calls it as a plain function.

New `pushFetch` hook on `PMRObject` and `MonitorIngest`: every Web Push delivery goes out through it. The default is the global `fetch`. Override it when a push service cannot be reached by a public fetch from the Worker, for example a route on the Worker's own zone, which can be reached through a service binding instead. It is called with `this` as the object. An override that uses a service binding calls its `fetch` as a method on the binding (`env.X.fetch(input, init)`), never extracted, because an extracted binding `fetch` throws "Illegal invocation".
