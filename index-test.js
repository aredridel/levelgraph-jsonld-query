const jldq = require('./')
const lg = require('levelgraph')
const test = require('estap').createSuite()
const memdb = require('memdb')
const db = lg(memdb())

test('query', t => jldq(db, {}, {}))
