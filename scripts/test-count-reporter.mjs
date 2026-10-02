// Node runner summary counts leaf tests; suite/container pass events are not tests.
export default async function* countReporter(source) {
  let count = null
  for await (const event of source) {
    if (event.type === 'test:summary' && event.data.file === undefined) count = event.data.counts.tests
  }
  if (!Number.isInteger(count)) throw new Error('Node test summary unavailable')
  yield `DSH_TEST_COUNT ${count}\n`
}
