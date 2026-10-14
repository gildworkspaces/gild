import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closingReferences } from './closing.ts'

test('a PR closes the issues its title or body names with a closing keyword', () => {
  assert.deepEqual(closingReferences('Closes #1'), [1])
  assert.deepEqual(
    closingReferences('fixes #2, Resolved #3 and close: #4. closed #2'),
    [2, 3, 4],
  )
  // Mentions without a keyword, other numbers and longer words do not close.
  assert.deepEqual(closingReferences('see #5; fixture #6; enclosed #7; issue 8'), [])
})
