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

runner.test('null query is accepted', async () => {
  const res = await jldq(db, {
    '@context': {
      'test': 'https://example.org/'
    }
  })
  assert.equal(res['@context'].test, 'https://example.org/')
})

runner.test('simple query is accepted', async () => {
  await db.put({
    '@context': {
      'test': 'https://example.org/',
      'Book': 'https://example.org/Book',
      'title': 'https://example.org/title'
    },
    "test": {
      "@type": "Book",
      "title": "The Little Engine That Could"
    }
  })
  const res = await jldq(db, {
    '@context': {
      'test': 'https://example.org/'
    },
    "test": {
      "@type": "Book"
    }
  })
  assert.equal(res['@context'].test, 'https://example.org/')
  assert.equal(res['@graph'].test.title, "The Little Engine That Could")
})

