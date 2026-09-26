import { NotifyError } from './_shared.mjs'
import {
  NetworkPolicyError,
  __setLookupForTests,
  guardedNetworkFetch,
  pinnedLookupFor,
  resolveNetworkTarget,
} from '../security/network-policy.mjs'

export { __setLookupForTests, guardedNetworkFetch, pinnedLookupFor, resolveNetworkTarget }

export async function assertPublicHttpUrl(url, options = {}) {
  try {
    await resolveNetworkTarget(url, options)
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      throw new NotifyError(error.message, error.code, { detail: error.detail })
    }
    throw error
  }
}
