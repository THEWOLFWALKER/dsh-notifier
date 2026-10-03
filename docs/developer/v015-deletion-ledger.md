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
| Advanced Console | RECOVERY_ONLY | read-only report view; routine tabs unavailable | markup + diagnostics contracts |
| adapters/** | KEEP | protocol assets | no protocol rewrite |
| Store core | KEEP | synchronous durable transactions | fault tests |
| old view-shape tests | DELETE | locked deleted UI; replaced by S2–S5 real React suites | DOM |
