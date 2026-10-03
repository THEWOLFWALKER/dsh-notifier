# v0.15 deletion ledger

| Path / symbol | Decision | Reason / replacement | Validation |
|---|---|---|---|
| client old Channels/ChannelDetail/SetupFlow | DELETE | Native channel shell + account cards | S2/S3 DOM; release DOM import/custom address |
| Sessions/SessionDetail/Bindings daily UI | DELETE | explicit current task | deep links normalize to Native |
| Members/Pairing/Pending daily UI | DELETE | Native private chat and pending flows | S4 DOM |
| old Tasks/Questions/Health/Activity presentation | DELETE | bounded Native task/pending/receipt data | native behavior + DOM |
| unused locale properties + health CSS | DELETE | no remaining rendering consumers | locale lint + DOM |
| control-surface/service.mjs | SHRINK | transport dispatch only | service integration contracts |
| compatibility-adapter.mjs | KEEP | old Host/API contracts; shared secondary settings | focused compatibility tests |
| Advanced Console | RECOVERY_ONLY | read-only report view; routine markup deleted, startup reads diagnostics only | recovery startup behavior + diagnostics/auth contracts |
| adapters/** | KEEP | protocol assets | no protocol rewrite |
| Store core | KEEP | synchronous durable transactions | fault tests |
| old view-shape tests | DELETE | locked deleted UI; replaced by S2–S5 real React suites | DOM |

P5 gate follow-up: deleted 24 obsolete recovery daily-UI tests plus seven obsolete Native session/helper UI tests and replaced them with public startup/report behavior. Group protocol ingress tests now prove rejection; private message normalization and outbound group notification assets remain covered. Group denial sends no group reply, preventing queued reply growth during the 1025-event QQ flood drill.
