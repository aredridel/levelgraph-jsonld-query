const jldq = require('./')
const lg = require('levelgraph')
const TestRunner = require('test-runner')
const runner = new TestRunner()
const memdb = require('memdb')
const db = lg(memdb())
const assert = require('assert')

runner.test('no arguments is rejected', async () => {
  try {
    await jldq()
  } catch (e) {
    assert.equal(e.message, 'Expected 2 or 3 argument but got 0')
  }
})

runner.test('only one argument is rejected', async () => {
  try {
    await jldq(db)
  } catch (e) {
    assert.equal(e.message, 'Expected 2 or 3 argument but got 1')
  }
})

runner.test('empty query is rejected', async () => {
  try {
    await jldq(db, {})
  } catch (e) {
    assert.equal(e.message, 'Invalid JSON-LD syntax; a JSON-LD frame must be a single object.')
  }
})

runner.test('Simple query is accepted', async () => {
    await jldq(db, {
      '@context': {
        'test': 'https://example.org/'
      }
    })
})

