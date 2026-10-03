# Stage 3 fault and capacity evidence

Tests exercise live services, actual disk/restart state, and real React DOM; source scans are reserved for vocabulary/package gates.

| Boundary | Behavior evidence |
|---|---|
| Store rename contention / exhausted retries | `v015-p3-lifecycle`: real filesystem rename injection, memory rollback and disk reopen |
| Live lock / corrupt state | `store`, `store-shape-corrupt-v0121` |
| Claim crash / effect then settlement crash / duplicates | `v015-stage-s9-claim-convergence` |
| Runtime replace / old completion / disposal | `v015-p0-corrective`, `v015-p3-lifecycle`, `v014-stage-c-runtime-truth` |
| Accepted / confirmed / unknown / partial send / retry isolation | `v015-stage-s6-delivery-evidence-health`, `notify`, `segment` |
| Cloud response loss / receipt persistence failure / verify failure | `cloudflare-release`: exact named resource readback, reopen disk Store, no duplicate deployment |
| Cloud restart steps / failed apply / cancellation / manual edits | `cloudflare-release`: prepare, database, migration, create, verify, apply; retained resources and public status |
| Import stale preview / explicit secret clear / failed apply after commit | `v015-stage-s13-config-portability` |
| Group admission before routing | `v015-private-admission`: all six ingress types |

Long-run drills: 1000 notification HTTP requests to a local server, 500 admitted private events, 1000 replace/retire cycles, and 1000 Cloud status reads. They assert successful operations and no pending waiter/subscription growth, rather than machine-specific timing.

Runtime identity fences cap at 128 types and observer registrations at 256; new overflow is rejected before source mutation. Health tracks at most 128 types, with 100 maximum entries per type and a default 24-hour TTL. Runtime disposal retires all live senders, invalidates generations, and unsubscribes every source observer. Cloud startup sweeps terminal history to 64 rows / seven days; unfinished claims are retained and resumed serially once per startup. Existing bus/dedup/pairing/import/merge/history caps remain in their owners.

## Evidence limit

Wrangler deployment-list readback supplies versions, but does not guarantee an endpoint. If the create response and durable receipt are both unavailable and readback has no endpoint, recovery deliberately remains `recovery-required`. A public Cloudflare account walkthrough is BLOCKED by absent account credentials; fixtures prove the safe recovery branch and the exact-resource branch with an endpoint, not public account operation. Real provider/device delivery and a full DSH-host walkthrough also need external access. These are not represented as completed evidence.
