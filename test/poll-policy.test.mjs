// The commit pill's polling schedule, without timers or React.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  POLL_ACTIVE_MS,
  POLL_ERROR_FIRST_MS,
  POLL_ERROR_MAX_MS,
  POLL_IDLE_MS,
  nextPollDelay,
} from '../src/client/poll-policy.ts'

test('an active commit task polls fast; everything else polls at the idle interval', () => {
  assert.equal(nextPollDelay({ working: true, hidden: false, errorCount: 0 }), POLL_ACTIVE_MS)
  // A marker-less archive with no live task is not evidence of progress: a
  // crashed extraction must not keep the five-second timer alive forever.
  assert.equal(nextPollDelay({ working: false, hidden: false, errorCount: 0 }), POLL_IDLE_MS)
})

test('a hidden tab schedules nothing; a visible one resumes', () => {
  assert.equal(nextPollDelay({ working: true, hidden: true, errorCount: 0 }), 0)
  assert.equal(nextPollDelay({ working: false, hidden: true, errorCount: 3 }), 0)
  assert.equal(nextPollDelay({ working: false, hidden: false, errorCount: 0 }), POLL_IDLE_MS)
})

test('failures back off exponentially and cap, and success resets', () => {
  const delays = [1, 2, 3, 4, 5, 6].map((errorCount) =>
    nextPollDelay({ working: false, hidden: false, errorCount }),
  )
  assert.deepEqual(delays, [
    POLL_ERROR_FIRST_MS,
    POLL_ERROR_FIRST_MS * 2,
    POLL_ERROR_FIRST_MS * 4,
    POLL_ERROR_FIRST_MS * 8,
    POLL_ERROR_MAX_MS,
    POLL_ERROR_MAX_MS,
  ])
  assert.equal(nextPollDelay({ working: true, hidden: false, errorCount: 2 }), POLL_ERROR_FIRST_MS * 2)
  assert.equal(nextPollDelay({ working: false, hidden: false, errorCount: 0 }), POLL_IDLE_MS)
})
