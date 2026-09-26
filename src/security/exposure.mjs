// v0.13 security policy: public exposure is opt-in. Unknown fields are secret.
// Legacy `secret:false` / `plain:true` declarations remain compatible until
// every field table is migrated to the explicit `exposure` vocabulary.
export function isPublicExposure(meta) {
  return meta?.exposure === 'public'
    || (meta?.exposure === undefined && (meta?.secret === false || meta?.plain === true))
}

export function exposureOf(meta) {
  return isPublicExposure(meta) ? 'public' : 'secret'
}
