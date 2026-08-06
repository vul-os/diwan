#!/usr/bin/env node
// assert-p2p-suite-ran.mjs — fail closed if the built-in-rendezvous P2P suite
// did not actually EXECUTE.
//
// `playwright test --list` (the mechanism this replaced) only proves a test
// was COLLECTED. Its output is byte-identical whether every test in the file
// ran to completion or every one of them skipped itself at runtime (e.g. a
// beforeAll that bails on a bad precondition) — `playwright test` also exits
// 0 in that case. So a collection-only check cannot catch "the suite quietly
// stopped running".
//
// This script instead reads Playwright's JSON reporter output — one entry
// per test with its ACTUAL run-time status — and asserts, by exact count,
// that the tests in e2e-p2p/builtin-rendezvous-p2p.e2e.ts (the suite proving
// Diwan's built-in, no-relay P2P discovery works, which has no external
// dependency and so must never be allowed to just not run) all report
// "passed". A renamed file or a testMatch that stops matching the file
// yields zero collected specs for it, which fails the count check exactly
// like it does today. A beforeAll that bails, or any other cause of the
// tests reporting "skipped" or "failed" instead of "passed", now ALSO fails
// this check — which a collection-only `--list` grep could never do.
//
// Usage: node assert-p2p-suite-ran.mjs <path-to-playwright-json-report>

import { readFileSync } from 'node:fs'

/**
 * The subset of Playwright's `json` reporter shape this script actually
 * relies on. Hand-written (not imported from @playwright/test/reporter) so
 * that a field this script reads — e.g. `.status` — is what gets checked;
 * a typo'd field name here becomes a compile error instead of silently
 * resolving to `undefined` the way untyped `JSON.parse` output would.
 * @typedef {Object} P2PReportTestResult
 * @property {string} status
 */
/**
 * @typedef {Object} P2PReportTest
 * @property {P2PReportTestResult[]} [results]
 */
/**
 * @typedef {Object} P2PReportSpec
 * @property {string} file
 * @property {string} title
 * @property {P2PReportTest[]} [tests]
 */
/**
 * @typedef {Object} P2PReportSuite
 * @property {P2PReportSuite[]} [suites]
 * @property {P2PReportSpec[]} [specs]
 */
/**
 * @typedef {Object} P2PReport
 * @property {P2PReportSuite[]} [suites]
 */
/**
 * @typedef {Object} CollectedTest
 * @property {string} file
 * @property {string} title
 * @property {string} status
 */

const SUITE_FILE = 'builtin-rendezvous-p2p.e2e.ts'
const EXPECTED_PASSED_COUNT = 4
const REQUIRED_TITLE_SUBSTRING = 'THE PAYOFF'

const reportPath = process.argv[2]
if (!reportPath) {
  console.error('FAIL: usage: assert-p2p-suite-ran.mjs <playwright-json-report>')
  process.exit(1)
}

/** @type {P2PReport} */
let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (err) {
  console.error(`FAIL: could not read/parse Playwright JSON report at ${reportPath}: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

/**
 * Flatten Playwright's nested suite tree into { file, title, status }[].
 * @param {P2PReportSuite} suite
 * @param {CollectedTest[]} out
 * @returns {CollectedTest[]}
 */
function collectTests(suite, out) {
  for (const child of suite.suites ?? []) collectTests(child, out)
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        out.push({ file: spec.file, title: spec.title, status: result.status })
      }
    }
  }
  return out
}

const allTests = (report.suites ?? []).flatMap((s) => collectTests(s, []))
const suiteTests = allTests.filter((t) => t.file.endsWith(SUITE_FILE))

console.log(`── ${SUITE_FILE} — tests found in JSON report: ${suiteTests.length} ──`)
for (const t of suiteTests) console.log(`  [${t.status}] ${t.title}`)

if (suiteTests.length === 0) {
  console.error(
    `FAIL: no tests from ${SUITE_FILE} appear in the report at all — ` +
    'the file was renamed, moved out of testMatch, or never collected.',
  )
  process.exit(1)
}

const passed = suiteTests.filter((t) => t.status === 'passed')
const notPassed = suiteTests.filter((t) => t.status !== 'passed')

if (notPassed.length > 0) {
  console.error(
    `FAIL: ${notPassed.length} test(s) in ${SUITE_FILE} did not report status "passed": ` +
    notPassed.map((t) => `[${t.status}] ${t.title}`).join('; '),
  )
  process.exit(1)
}

if (passed.length !== EXPECTED_PASSED_COUNT) {
  console.error(
    `FAIL: expected exactly ${EXPECTED_PASSED_COUNT} passed test(s) in ${SUITE_FILE}, ` +
    `found ${passed.length}. Fewer means the suite lost coverage; more means this ` +
    'script\'s expected count is stale and must be updated deliberately.',
  )
  process.exit(1)
}

if (!passed.some((t) => t.title.includes(REQUIRED_TITLE_SUBSTRING))) {
  console.error(`FAIL: no passed test in ${SUITE_FILE} has a title containing "${REQUIRED_TITLE_SUBSTRING}".`)
  process.exit(1)
}

console.log(`PASS: exactly ${EXPECTED_PASSED_COUNT} tests in ${SUITE_FILE} executed with status "passed", ` +
  `including the "${REQUIRED_TITLE_SUBSTRING}" test.`)
