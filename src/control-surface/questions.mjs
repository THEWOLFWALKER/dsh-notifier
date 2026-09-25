export function createQuestionProjection({ getQuestions, settle } = {}) {
  return {
    list() {
      let rows = []
      try { rows = typeof getQuestions === 'function' ? getQuestions() : [] } catch { rows = [] }
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        ref: String(row?.ref ?? ''),
        question: String(row?.question ?? ''),
        multiple: row?.multiSelect === true,
        options: (Array.isArray(row?.options) ? row.options : []).map((label, index) => ({
          value: String(index),
          label: String(label),
        })),
        status: 'pending',
        ...(Number.isFinite(Number(row?.expiresAt)) ? { expiresAt: new Date(Number(row.expiresAt)).toISOString() } : {}),
      }))
    },

    settle(payload = {}) {
      const normalized = {
        ref: String(payload?.ref ?? ''),
        action: String(payload?.action ?? ''),
        options: Array.isArray(payload?.options) ? payload.options.map((value) => Number(value)) : [],
      }
      const result = settle(normalized)
      if (result?.ok === true || result?.settled === true) {
        return { settled: true, alreadyHandled: false }
      }
      if (result?.handled === true || result?.alreadyHandled === true) {
        return { settled: false, alreadyHandled: true }
      }
      const error = new Error(String(result?.message ?? '结算未生效'))
      if (result?.reason === 'expired') error.code = 'conflict'
      else if (result?.reason === 'unknown_question' || result?.reason === 'no_target') error.code = 'not-found'
      else if (result?.reason === 'invalid_action' || result?.reason === 'invalid_option') error.code = 'bad-request'
      else if (result?.reason === 'not_available') error.code = 'not-supported'
      else error.code = 'conflict'
      throw error
    },
  }
}
