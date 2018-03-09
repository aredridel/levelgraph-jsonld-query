const jsonld = require('jsonld').promises
const jsonldraw = require('jsonld')
const aproba = require('aproba')
const preduce = require('p-reduce')
const pmap = require('p-map')
const N3Util = require('n3/lib/N3Util')
const RDFTYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

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

  options = options || {};

  // set default options
  if (!('base' in options))
    options.base = '';

  if (!('documentLoader' in options))
    options.documentLoader = jsonld.loadDocument;

  if (!('embed' in options))
    options.embed = '@last';

  if (!('requireAll' in options))
    options.requireAll = true;

  options.explicit = options.explicit || false;

  options.omitDefault = options.omitDefault || false;

  const remoteFrame = {
    contextUrl: null,
    documentUrl: null,
    document: frame
  };

  // preserve frame context and add any Link header context
  frame = remoteFrame.document;

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
  const opts = _clone(options);
  opts.isFrame = true;
  opts.keepFreeFloatingNodes = true;
  const expandedFrame = await jsonld.expand(frame, opts)

  console.warn('expanded frame', JSON.stringify(expandedFrame[0], null, 2))

  const fetched = await pmap(expandedFrame, (frameUnit) => expandFrameUnit(db, frameUnit))

  return await jsonld.frame(fetched, frame, opts)
}

async function expandFrameUnit(db, frameUnit, subject) {
  console.warn('expanding', frameUnit, subject)
  if (subject && frameUnit['@id'] && frameUnit['@id'] != subject) return null
  if (!subject) {
    subject = db.v('subject')
  }
  const predicates = Object.keys(frameUnit)
  const results = await db.search(predicates.map(predicateOrKeyword => {
    const predicate = expandKeywords(predicateOrKeyword)
    return {
      subject,
      predicate
    }
  }))
  console.warn('rrrr', results)
  results.forEach(e => {
    if (!e.subject) e.subject = subject
  })
  const out = await pmap(results, ({subject}) => matchResults(db, subject, frameUnit))

  console.warn('www', out)
  return out
}

async function matchResults(db, subject, frameUnit) {
  console.warn('matching', subject, frameUnit)
  const predicates = Object.keys(frameUnit)
  const results = frameUnit['@explicit'] ? await preduce(predicates, async (acc, predicateOrKeyword) => { 
    if (isKeyword(predicateOrKeyword) && predicateOrKeyword != '@type') return acc
    const predicate = expandKeywords(predicateOrKeyword)
    const triples = await db.get({
      subject,
      predicate
    })

    return acc.concat(triples)
  }) : await db.get({subject})

  const expanded = await preduce(results, async (acc, {subject, predicate, object}) => {
    const prop = compactKeywords(predicate)
    // FIXME: multiple values for a single predicate
    if (N3Util.isIRI(object) || N3Util.isBlank(object)) {
      if (frameUnit[predicate]) {
        const expanded = flatten(await pmap(frameUnit[predicate], (subFrameUnit) => expandFrameUnit(db, subFrameUnit, object)))
        console.warn('eeee', expanded)
        acc[prop] = expanded
      } else {
        const expanded = await expandFrameUnit(db, {}, object)
        acc[prop] = expanded.length ? expanded : object
      }
    } else{
      acc[prop] = object
    }

    console.warn('prop', predicate, acc[prop])
    return acc
  }, {})
    
  console.warn('yyy', expanded)
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
