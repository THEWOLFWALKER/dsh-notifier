// Minimal Node test reporter: print only how many test points the runner executed.
//
// Used by `run-tests.mjs --count` so the release guard can read the **real** discovered count
// without parsing megabytes of TAP. A test point is any `test:pass` / `test:fail` event — the
// same tally Node's own TAP reporter reports as `# tests N`, so the number stays comparable
// to what a human sees in a normal `npm test` run.
export default async function* countReporter(source) {
  let points = 0
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') points += 1
  }
  // 带标记输出：测试自身/子进程可能往 stdout 写任意文本，裸数字会被误读；调用方按标记取数。
  process.stdout.write(`DSH_TEST_COUNT ${points}\n`)
}