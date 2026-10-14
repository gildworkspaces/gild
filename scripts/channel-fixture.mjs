import assert from 'node:assert/strict'
/** A failed drain must fail the suite instead of relying on an alarm race. */
export async function flushChannelFixture(request) {
  const response = await request('/flush-events','POST')
  assert.equal(response.status,200,await response.clone().text())
}
