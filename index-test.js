const jldq = require('./')
const lg = require('levelgraph')
const TestRunner = require('test-runner')
const runner = new TestRunner()
const memdb = require('memdb')
const addManifest = require('levelgraph-jsonld-manifest')
const lgjsonld = require('levelgraph-jsonld')
const levelPromise = require('level-promise')
const db = levelPromise(addManifest(lgjsonld(lg(memdb()))))
const assert = require('assert')
const debug = require('util').debuglog('levelgraph-jsonld-query')

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
  await db.jsonld.put({
    '@context': {
      'item': 'https://example.org/item',
      'Book': 'https://example.org/Book',
      'title': 'https://example.org/title',
    },
    "item": {
      "@type": "Book",
      "title": "The Little Engine That Could",
    }
  })
  debug('xxx', await db.get({}))
  const res = await jldq(db, {
    '@context': {
      'item': 'https://example.org/item',
      'Book': 'https://example.org/Book',
      'title': 'https://example.org/title',
    },
    "item": {
      "@type": "Book"
    },
  })
  debug(JSON.stringify(res, null, 2))
  assert.equal(res['@context'].item, 'https://example.org/item')
  assert.equal(res['@graph'][0].item.title, "The Little Engine That Could")
})
