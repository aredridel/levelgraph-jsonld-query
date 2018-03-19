const jsonld = require('jsonld').promises
const jsonldraw = require('jsonld')
const aproba = require('aproba')
const preduce = require('p-reduce')
const pmap = require('p-map')
const debug = require('util').debuglog('levelgraph-jsonld-query')
const N3Util = require('n3/lib/N3Util')
const RDFTYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFFIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first'
const RDFREST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest'
const RDFNIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil'
const RDFLANGSTRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'
const XSDTYPE = 'http://www.w3.org/2001/XMLSchema#'

/**
 * Query using a JSON-LD frame
 *
 * @param frame the JSON-LD frame to use.
 * @param [options] the framing options.
 *          [base] the base IRI to use.
 *          [embed] default @embed flag: '@last', '@always', '@never', '@link'
 *            (default: '@last').
 *          [explicit] default @explicit flag (default: false).
 *          [requireAll] default @requireAll flag (default: true).
 *          [omitDefault] default @omitDefault flag (default: false).
 *          [documentLoader(url, callback(err, remoteDoc))] the document loader.
 */
module.exports = async function query(db, frame, options) {
  aproba('OO|OOO', arguments)

  const opts = _clone(options || {});

  // set default options
  if (!('base' in opts))
    opts.base = '';

  if (!('documentLoader' in opts))
    opts.documentLoader = jsonld.loadDocument;

  if (!('embed' in opts))
    opts.embed = '@last';

  if (!('requireAll' in opts))
    opts.requireAll = true;

  opts.explicit = opts.explicit || false;

  opts.omitDefault = opts.omitDefault || false;

  const remoteFrame = {
    contextUrl: null,
    documentUrl: null,
    document: frame
  };

  let ctx;
  if (frame) {
    ctx = frame['@context'];
    if (remoteFrame.contextUrl) {
      if (!ctx) {
        ctx = remoteFrame.contextUrl;
      } else if (Array.isArray(ctx)) {
        ctx.push(remoteFrame.contextUrl);
      } else {
        ctx = [ctx, remoteFrame.contextUrl];
      }
      frame['@context'] = ctx;
    } else {
      ctx = ctx || {};
    }
  } else {
    ctx = {};
  }

  // expand frame
  opts.isFrame = true;
  opts.keepFreeFloatingNodes = true;
  const expandedFrame = await jsonld.expand(frame, opts)

  debug('expanded frame', JSON.stringify(expandedFrame[0], null, 2))

  const fetched = await pmap(expandedFrame, (frameUnit) => expandFrameUnit(db, frameUnit))

  return await jsonld.frame(fetched, frame, opts)
}

async function expandFrameUnit(db, frameUnit, subject) {
  debug('expanding', frameUnit, subject)
  if (subject && frameUnit['@id'] && frameUnit['@id'] != subject) return null
  if (!subject) {
    subject = db.v('subject')
  }
  const predicates = Object.keys(frameUnit)
  debug('xxx', await db.get({}))
  const results = await db.search(predicates.map(predicateOrKeyword => {
    const predicate = expandKeywords(predicateOrKeyword)
    return {
      subject,
      predicate
    }
  }))
  debug('found', results.map(r => r.subject), 'for', subject)
  results.forEach(e => {
    if (!e.subject)
      e.subject = subject
  })
  const out = await pmap(results, ({subject}) => matchResults(db, subject, frameUnit))

  debug('matched', out, 'for', subject)
  return out
}

async function matchResults(db, subject, frameUnit) {
  debug('matching', subject, frameUnit)
  const predicates = Object.keys(frameUnit)
  const results = frameUnit['@explicit'] ? await preduce(predicates, async (acc, predicateOrKeyword) => {
    if (isKeyword(predicateOrKeyword) && predicateOrKeyword != '@type') return acc
    const predicate = expandKeywords(predicateOrKeyword)
    const triples = await db.get({
      subject,
      predicate
    })

    return acc.concat(triples)
  }) : await db.get({
    subject
  })

  const expanded = await preduce(results, async (acc, {subject, predicate, object}) => {
    const prop = compactKeywords(predicate)
    if (N3Util.isIRI(object) || N3Util.isBlank(object)) {
      if (frameUnit[predicate]) {
        const expanded = flatten(await pmap(frameUnit[predicate], (subFrameUnit) => expandFrameUnit(db, subFrameUnit, object)))
        addProp(acc, prop, expanded)
      } else {
        const expanded = await expandFrameUnit(db, {}, object)
        addProp(acc, prop, expanded.length ? expanded : object)
      }
    } else {
      addProp(acc, prop, getCoercedObject(object))
    }

    debug('prop', predicate, acc[prop])
    return acc
  }, {})

  return expanded
}

function _clone(obj) {
  if (typeof obj == 'string') return obj
  const out = {}
  for (let k in obj) {
    out[k] = obj[k]
  }
  return out
}

function isKeyword(v) {
  if (typeof v != 'string') return false
  switch (v) {
    case '@base':
    case '@context':
    case '@container':
    case '@default':
    case '@embed':
    case '@explicit':
    case '@graph':
    case '@id':
    case '@index':
    case '@language':
    case '@list':
    case '@omitDefault':
    case '@preserve':
    case '@requireAll':
    case '@reverse':
    case '@set':
    case '@type':
    case '@value':
    case '@vocab':
      return true
  }
  return false
}

function expandKeywords(predicate) {
  if (predicate == '@type') return RDFTYPE
  return predicate
}

function compactKeywords(predicate) {
  if (predicate == RDFTYPE) return '@type'
  return predicate
}

function flatten(arr) {
  return arr.reduce((acc, e) => acc.concat(e), [])
}

function addProp(obj, prop, value) {
  if (!obj[prop]) {
    obj[prop] = []
  }
  obj[prop].push(value)
}

// http://json-ld.org/spec/latest/json-ld-api/#data-round-tripping
function getCoercedObject(object) {
  var TYPES = {
    PLAIN: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#PlainLiteral',
    BOOLEAN: XSDTYPE + 'boolean',
    INTEGER: XSDTYPE + 'integer',
    DOUBLE: XSDTYPE + 'double',
    STRING: XSDTYPE + 'string',
  };
  var value = N3Util.getLiteralValue(object);
  var type = N3Util.getLiteralType(object);
  var coerced = {};
  switch (type) {
    case TYPES.STRING:
    case TYPES.PLAIN:
      coerced['@value'] = value;
      break;
    case RDFLANGSTRING:
      coerced['@value'] = value;
      coerced['@language'] = N3Util.getLiteralLanguage(object);
      break;
    case TYPES.INTEGER:
      coerced['@value'] = parseInt(value, 10);
      break;
    case TYPES.DOUBLE:
      coerced['@value'] = parseFloat(value);
      break;
    case TYPES.BOOLEAN:
      if (value === 'true' || value === '1') {
        coerced['@value'] = true;
      } else if (value === 'false' || value === '0') {
        coerced['@value'] = false;
      } else {
        throw new Error('value not boolean!');
      }
      break;
    default:
      coerced = {
        '@value': value,
        '@type': type
      };
  }
  return coerced;
}
