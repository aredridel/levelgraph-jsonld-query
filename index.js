const jsonld = require('jsonld').promises;
const jsonldraw = require('jsonld')
const aproba = require('aproba')

/**
 * Query using a JSON-LD frame
 *
 * @param frame the JSON-LD frame to use.
 * @param [options] the framing options.
 *          [base] the base IRI to use.
 *          [expandContext] a context to expand with.
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

  const state = {
    subjects: {},
    options: options,
    graphs: {
      '@default': {},
      '@merged': {}
    },
    subjectStack: [],
    link: {}
  };

  // frame the subjects
  const framed = [];
  await _frame(db, state, expandedFrame, framed, null);

  // compact result (force @graph option to true, skip expansion,
  // check for linked embeds)
  opts.graph = true;
  opts.skipExpansion = true;
  opts.link = {};

  const { compacted, ctx: activeCtx } = await jsonldcompact(framed, ctx, opts)

  // get graph alias
  const graph = _compactIri(activeCtx, '@graph');
  // remove @preserve from results
  opts.link = {};
  compacted[graph] = _removePreserve(activeCtx, compacted[graph], opts);

  return compacted;
};

/**
 * Compacts an IRI or keyword into a term or prefix if it can be. If the
 * IRI has an associated value it may be passed.
 *
 * @param activeCtx the active context to use.
 * @param iri the IRI to compact.
 *
 * @return the compacted term, prefix, keyword alias, or the original IRI.
 */
function _compactIri(activeCtx, iri) {
  // can't compact null
  if (iri === null) return iri;

  const relativeTo = {};

  // if term is a keyword, default vocab to true
  if (_isKeyword(iri)) relativeTo.vocab = true;

  // use inverse context to pick a term if iri is relative to vocab
  if (relativeTo.vocab && iri in activeCtx.getInverse()) {
    const defaultLanguage = activeCtx['@language'] || '@none';

    // prefer @index if available in value
    const containers = [];

    // defaults for term selection based on type/language
    const typeOrLanguage = '@type';
    const typeOrLanguageValue = '@id';

    containers.push('@set');

    // do term selection
    containers.push('@none');
    const term = _selectTerm(activeCtx, iri, null, containers, typeOrLanguage, typeOrLanguageValue);
    if (term != null) return term;
  }

  // no term match, use @vocab if available
  if (relativeTo.vocab && '@vocab' in activeCtx) {
    // determine if vocab is a prefix of the iri
    const vocab = activeCtx['@vocab'];
    if (iri.indexOf(vocab) == 0 && iri != vocab) {
      // use suffix as relative iri if it is not a term in the active context
      const suffix = iri.substr(vocab.length);
      if (!(suffix in activeCtx.mappings)) return suffix;
    }
  }

  // no term or @vocab match, check for possible CURIEs
  let choice = null;
  for (let term in activeCtx.mappings) {
    const definition = activeCtx.mappings[term];
    // skip null definitions and terms with colons, they can't be prefixes
    if (!definition || definition._termHasColon) {
      continue;
    }
    // skip entries with @ids that are not partial matches
    if (!(iri.length > definition['@id'].length && iri.indexOf(definition['@id']) == 0)) {
      continue;
    }

    // a CURIE is usable if:
    // 1. it has no mapping, OR
    // 2. value is null, which means we're not compacting an @value, AND
    //   the mapping matches the IRI)
    const curie = term + ':' + iri.substr(definition['@id'].length);
    const isUsableCurie = (!(curie in activeCtx.mappings) || (activeCtx.mappings[curie] && activeCtx.mappings[curie]['@id'] == iri));

    // select curie if it is shorter or the same length but lexicographically
    // less than the current choice
    if (isUsableCurie && (choice === null || _compareShortestLeast(curie, choice) < 0)) {
      choice = curie;
    }
  }

  // return chosen curie
  if (choice !== null) return choice;

  // compact IRI relative to base
  if (!relativeTo.vocab) return _removeBase(activeCtx['@base'], iri);

  // return IRI as is
  return iri;
}

/**
 * Frames subjects according to the given frame.
 *
 * @param db the levelgraph-jsonld instance
 * @param state the current framing state.
 * @param frame the frame.
 * @param parent the parent subject or top-level array.
 * @param property the parent property, initialized to null.
 */
async function _frame(db, state, frame, parent, property) {
  // validate the frame
  _validateFrame(frame);
  frame = frame[0];

  // get flags for current frame
  const options = state.options;
  const flags = {
    embed: _getFrameFlag(frame, options, 'embed'),
    explicit: _getFrameFlag(frame, options, 'explicit'),
    requireAll: _getFrameFlag(frame, options, 'requireAll')
  };

  // filter out subjects that match the frame
  const matches = await _findSubjects(db, state, frame, flags);

  // add matches to output
  const ids = Object.keys(matches).sort();
  for (let idx = 0; idx < ids.length; ++idx) {
    const id = ids[idx];
    const subject = matches[id];

    if (flags.embed == '@link' && id in state.link) {
      // TODO: may want to also match an existing linked subject against
      // the current frame ... so different frames could produce different
      // subjects that are only shared in-memory when the frames are the same

      // add existing linked subject
      _addFrameOutput(parent, property, state.link[id]);
      continue;
    }

    /* Note: In order to treat each top-level match as a compartmentalized
    result, clear the unique embedded subjects map when the property is null,
    which only occurs at the top-level. */
    if (property === null) {
      state.uniqueEmbeds = {};
    }

    // start output for subject
    const output = {};
    output['@id'] = id;
    state.link[id] = output;

    // if embed is @never or if a circular reference would be created by an
    // embed, the subject cannot be embedded, just add the reference;
    // note that a circular reference won't occur when the embed flag is
    // `@link` as the above check will short-circuit before reaching this point
    if (flags.embed == '@never' || _createsCircularReference(subject, state.subjectStack)) {
      _addFrameOutput(parent, property, output);
      continue;
    }

    // if only the last match should be embedded
    if (flags.embed == '@last') {
      // remove any existing embed
      if (id in state.uniqueEmbeds) {
        _removeEmbed(state, id);
      }
      state.uniqueEmbeds[id] = {
        parent: parent,
        property: property
      };
    }

    // push matching subject onto stack to enable circular embed checks
    state.subjectStack.push(subject);

    // iterate over subject properties
    const props = Object.keys(subject).sort();
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];

      // copy keywords to output
      if (_isKeyword(prop)) {
        output[prop] = _clone(subject[prop]);
        continue;
      }

      // explicit is on and property isn't in the frame, skip processing
      if (flags.explicit && !(prop in frame)) {
        continue;
      }

      // add objects
      const objects = subject[prop];
      for (let oi = 0; oi < objects.length; ++oi) {
        const o = objects[oi];

        // recurse into list
        if (o && ('@list' in o)) {
          // add empty list
          const list = {
            '@list': []
          };
          _addFrameOutput(output, prop, list);

          // add list objects
          const src = o['@list'];
          for (let n in src) {
            o = src[n];
            if (_isSubjectReference(o)) {
              const subframe = (prop in frame ?
                frame[prop][0]['@list'] : _createImplicitFrame(flags));
              // recurse into subject reference
              await _frame(db, state, [o['@id']], subframe, list, '@list');
            } else {
              // include other values automatically
              _addFrameOutput(list, '@list', _clone(o));
            }
          }
          continue;
        }

        if (_isSubjectReference(o)) {
          // recurse into subject reference
          const subframe = (prop in frame ?  frame[prop] : _createImplicitFrame(flags));
          await _frame(db, state, [o['@id']], subframe, output, prop);
        } else {
          // include other values automatically
          _addFrameOutput(output, prop, _clone(o));
        }
      }
    }

    // handle defaults
    const frameKeys = Object.keys(frame).sort();
    for (let i = 0; i < frameKeys.length; ++i) {
      const prop = frameKeys[i];

      // skip keywords
      if (_isKeyword(prop)) continue;

      // if omit default is off, then include default values for properties
      // that appear in the next frame but are not in the matching subject
      const next = frame[prop][0];
      const omitDefaultOn = _getFrameFlag(next, options, 'omitDefault');
      if (!omitDefaultOn && !(prop in output)) {
        let preserve = '@null';
        if ('@default' in next) {
          preserve = _clone(next['@default']);
        }
        if (!Array.isArray(preserve)) {
          preserve = [preserve];
        }
        output[prop] = [{
          '@preserve': preserve
        }];
      }
    }

    // add output to parent
    _addFrameOutput(parent, property, output);

    // pop matching subject from circular ref-checking stack
    state.subjectStack.pop();
  }
}

/**
 * Returns whether or not the given value is a keyword.
 *
 * @param v the value to check.
 *
 * @return true if the value is a keyword, false if not.
 */
function _isKeyword(v) {
  if (typeof v != 'string') return false;
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
      return true;
  }
  return false;
}

function _clone(obj) {
  const out = {}
  for (let k in obj) {
    out[k] = obj[k]
  }
  return out
}

/**
 * Adds framing output to the given parent.
 *
 * @param parent the parent to add to.
 * @param property the parent property.
 * @param output the output to add.
 */
function _addFrameOutput(parent, property, output) {
  if (typeof parent == 'object') {
    addValue(parent, property, output, {
      propertyIsArray: true
    });
  } else {
    parent.push(output);
  }
}

/**
 * Removes the @preserve keywords as the last step of the framing algorithm.
 *
 * @param ctx the active context used to compact the input.
 * @param input the framed, compacted output.
 * @param options the compaction options used.
 *
 * @return the resulting output.
 */
function _removePreserve(ctx, input, options) {
  // recurse through arrays
  if (Array.isArray(input)) {
    const output = [];
    for (let i = 0; i < input.length; ++i) {
      const result = _removePreserve(ctx, input[i], options);
      // drop nulls from arrays
      if (result !== null) {
        output.push(result);
      }
    }
    input = output;
  } else if (typeof input == 'object') {
    // remove @preserve
    if ('@preserve' in input) {
      if (input['@preserve'] == '@null') return null;
      return input['@preserve'];
    }

    // skip @values
    if (input && ('@value' in input)) {
      return input;
    }

    // recurse through @lists
    if (input && ('@list' in input)) {
      input['@list'] = _removePreserve(ctx, input['@list'], options);
      return input;
    }

    // handle in-memory linked nodes
    const idAlias = _compactIri(ctx, '@id');
    if (idAlias in input) {
      const id = input[idAlias];
      if (id in options.link) {
        const idx = options.link[id].indexOf(input);
        if (idx == -1) {
          // prevent circular visitation
          options.link[id].push(input);
        } else {
          // already visited
          return options.link[id][idx];
        }
      } else {
        // prevent circular visitation
        options.link[id] = [input];
      }
    }

    // recurse through properties
    for (let prop in input) {
      const result = _removePreserve(ctx, input[prop], options);
      const container = jsonld.getContextValue(ctx, prop, '@container');
      if (options.compactArrays && Array.isArray(result) && result.length == 1 && container === null) {
        result = result[0];
      }
      input[prop] = result;
    }
  }
  return input;
}

/**
 * Gets the frame flag value for the given flag name.
 *
 * @param frame the frame.
 * @param options the framing options.
 * @param name the flag name.
 *
 * @return the flag value.
 */
function _getFrameFlag(frame, options, name) {
  const flag = '@' + name;
  let rval = (flag in frame ? frame[flag][0] : options[name]);
  if (name == 'embed') {
    // default is "@last"
    // backwards-compatibility support for "embed" maps:
    // true => "@last"
    // false => "@never"
    if (rval == true) {
      rval = '@last';
    } else if (rval == false) {
      rval = '@never';
    } else if (rval != '@always' && rval != '@never' && rval != '@link') {
      rval = '@last';
    }
  }
  return rval;
}

/**
 * Compares two strings first based on length and then lexicographically.
 *
 * @param a the first string.
 * @param b the second string.
 *
 * @return -1 if a < b, 1 if a > b, 0 if a == b.
 */
function _compareShortestLeast(a, b) {
  if (a.length < b.length) {
    return -1;
  }
  if (b.length < a.length) {
    return 1;
  }
  if (a == b) {
    return 0;
  }
  return (a < b) ? -1 : 1;
}

/**
 * Removes a base IRI from the given absolute IRI.
 *
 * @param base the base IRI.
 * @param iri the absolute IRI.
 *
 * @return the relative IRI if relative to base, otherwise the absolute IRI.
 */
function _removeBase(base, iri) {
  // skip IRI processing
  if (base === null) return iri;

  if (typeof base == 'string') {
    base = jsonld.url.parse(base || '');
  }

  // establish base root
  let root = '';
  if (base.href != '') {
    root += (base.protocol || '') + '//' + (base.authority || '');
  } else if (iri.indexOf('//')) {
    // support network-path reference with empty base
    root += '//';
  }

  // IRI not relative to base
  if (iri.indexOf(root) != 0) {
    return iri;
  }

  // remove root from IRI and parse remainder
  const rel = jsonld.url.parse(iri.substr(root.length));

  // remove path segments that match (do not remove last segment unless there
  // is a hash or query)
  const baseSegments = base.normalizedPath.split('/');
  const iriSegments = rel.normalizedPath.split('/');
  const last = (rel.fragment || rel.query) ? 0 : 1;
  while (baseSegments.length > 0 && iriSegments.length > last) {
    if (baseSegments[0] != iriSegments[0]) break;
    baseSegments.shift();
    iriSegments.shift();
  }

  // use '../' for each non-matching base segment
  const rval = '';
  if (baseSegments.length > 0) {
    // don't count the last segment (if it ends with '/' last path doesn't
    // count and if it doesn't end with '/' it isn't a path)
    baseSegments.pop();
    for (let i = 0; i < baseSegments.length; ++i) {
      rval += '../';
    }
  }

  // prepend remaining segments
  rval += iriSegments.join('/');

  // add query and hash
  if (rel.query !== null) {
    rval += '?' + rel.query;
  }
  if (rel.fragment !== null) {
    rval += '#' + rel.fragment;
  }

  // handle empty base
  if (rval == '') {
    rval = './';
  }

  return rval;
}

/**
 * Validates a JSON-LD frame, throwing an exception if the frame is invalid.
 *
 * @param frame the frame to validate.
 */
function _validateFrame(frame) {
  if (!Array.isArray(frame) || frame.length != 1 || typeof frame[0] != 'object') {
    throw new TypeError('Invalid JSON-LD syntax; a JSON-LD frame must be a single object.');
  }
}

/**
 * Find subjects that match the current frame
 *
 * @param db the levelgraph-jsonld instance
 * @param state the current framing state.
 * @param frame the parsed frame
 * @param flags the frame flags
 *
 * @return array of subjects
 */
async function _findSubjects(db, state, frame, flags) {
  // If frame has ID, return that?
  // Otherwise, ???
  console.warn('x', JSON.stringify(frame, null, 2))
  await db.search({
    subject: db.v('subject'),
    predicate: '',
    object: ''
  })
  return []
}

/**
 * Returns a map of all of the subjects that match a parsed frame.
 *
 * @param state the current framing state.
 * @param subjects the set of subjects to filter.
 * @param frame the parsed frame.
 * @param flags the frame flags.
 *
 * @return all of the matched subjects.
 */
function _filterSubjects(state, subjects, frame, flags) {
  // filter subjects in @id order
  const rval = {};
  for (let i = 0; i < subjects.length; ++i) {
    const id = subjects[i];
    const subject = state.subjects[id];
    if (_filterSubject(subject, frame, flags)) {
      rval[id] = subject;
    }
  }
  return rval;
}

/**
 * Returns true if the given subject matches the given frame.
 *
 * @param subject the subject to check.
 * @param frame the frame to check.
 * @param flags the frame flags.
 *
 * @return true if the subject matches, false if not.
 */
function _filterSubject(subject, frame, flags) {
  // check @type (object value means 'any' type, fall through to ducktyping)
  if ('@type' in frame && !(frame['@type'].length == 1 && (typeof frame['@type'][0] == 'object'))) {
    const types = frame['@type'];
    for (let i = 0; i < types.length; ++i) {
      // any matching @type is a match
      if (jsonld.hasValue(subject, '@type', types[i])) {
        return true;
      }
    }
    return false;
  }

  // check ducktype
  let wildcard = true;
  let matchesSome = false;
  for (let key in frame) {
    if (_isKeyword(key)) {
      // skip non-@id and non-@type
      if (key != '@id' && key != '@type') {
        continue;
      }
      wildcard = false;

      // check @id for a specific @id value
      if (key == '@id' && (typeof frame[key] == 'string')) {
        if (subject[key] != frame[key]) {
          return false;
        }
        matchesSome = true;
        continue;
      }
    }

    wildcard = false;

    if (key in subject) {
      // frame[key] == [] means do not match if property is present
      if (Array.isArray(frame[key]) && frame[key].length == 0 && subject[key] !== undefined) {
        return false;
      }
      matchesSome = true;
      continue;
    }

    // all properties must match to be a duck unless a @default is specified
    const hasDefault = (Array.isArray(frame[key]) && (typeof frame[key][0] == 'object') &&
      '@default' in frame[key][0]);
    if (flags.requireAll && !hasDefault) {
      return false;
    }
  }

  // return true if wildcard or subject matches some properties
  return wildcard || matchesSome;
}

/**
 * Checks the current subject stack to see if embedding the given subject
 * would cause a circular reference.
 *
 * @param subjectToEmbed the subject to embed.
 * @param subjectStack the current stack of subjects.
 *
 * @return true if a circular reference would be created, false if not.
 */
function _createsCircularReference(subjectToEmbed, subjectStack) {
  for (let i = subjectStack.length - 1; i >= 0; --i) {
    if (subjectStack[i]['@id'] == subjectToEmbed['@id']) {
      return true;
    }
  }
  return false;
}

/**
 * Creates an implicit frame when recursing through subject matches. If
 * a frame doesn't have an explicit frame for a particular property, then
 * a wildcard child frame will be created that uses the same flags that the
 * parent frame used.
 *
 * @param flags the current framing flags.
 *
 * @return the implicit frame.
 */
function _createImplicitFrame(flags) {
  const frame = {};
  for (let key in flags) {
    if (flags[key] !== undefined) {
      frame['@' + key] = [flags[key]];
    }
  }
  return [frame];
}

/**
 * Returns true if the given value is a subject reference.
 *
 * @param v the value to check.
 *
 * @return true if the value is a subject reference, false if not.
 */
function _isSubjectReference(v) {
  return (_isObject(v) && Object.keys(v).length == 1 && ('@id' in v));
}

/**
 * Removes an existing embed.
 *
 * @param state the current framing state.
 * @param id the @id of the embed to remove.
 */
function _removeEmbed(state, id) {
  // get existing embed
  const embeds = state.uniqueEmbeds;
  const embed = embeds[id];
  const parent = embed.parent;
  const property = embed.property;

  // create reference to replace embed
  const subject = {
    '@id': id
  };

  // remove existing embed
  if (Array.isArray(parent)) {
    // replace subject with reference
    for (let i = 0; i < parent.length; ++i) {
      if (jsonld.compareValues(parent[i], subject)) {
        parent[i] = subject;
        break;
      }
    }
  } else {
    // replace subject with reference
    const useArray = Array.isArray(parent[property]);
    jsonld.removeValue(parent, property, subject, {
      propertyIsArray: useArray
    });
    addValue(parent, property, subject, {
      propertyIsArray: useArray
    });
  }

  // recursively remove dependent dangling embeds
  const removeDependents = function(id) {
    // get embed keys as a separate array to enable deleting keys in map
    const ids = Object.keys(embeds);
    for (let i = 0; i < ids.length; ++i) {
      const next = ids[i];
      if (next in embeds && _isObject(embeds[next].parent) &&
        embeds[next].parent['@id'] == id) {
        delete embeds[next];
        removeDependents(next);
      }
    }
  };
  removeDependents(id);
}

/**
 * Returns true if the given value is an Object.
 *
 * @param v the value to check.
 *
 * @return true if the value is an Object, false if not.
 */
function _isObject(v) {
  return (Object.prototype.toString.call(v) == '[object Object]');
}

/**
 * Picks the preferred compaction term from the given inverse context entry.
 *
 * @param activeCtx the active context.
 * @param iri the IRI to pick the term for.
 * @param value the value to pick the term for.
 * @param containers the preferred containers.
 * @param typeOrLanguage either '@type' or '@language'.
 * @param typeOrLanguageValue the preferred value for '@type' or '@language'.
 *
 * @return the preferred term.
 */
function _selectTerm(activeCtx, iri, value, containers, typeOrLanguage, typeOrLanguageValue) {
  if (typeOrLanguageValue === null) typeOrLanguageValue = '@null';

  // preferences for the value of @type or @language
  const prefs = [];

  // determine prefs for @id based on whether or not value compacts to a term
  if ((typeOrLanguageValue == '@id' || typeOrLanguageValue == '@reverse') && _isSubjectReference(value)) {
    // prefer @reverse first
    if (typeOrLanguageValue == '@reverse') prefs.push('@reverse');
    // try to compact value to a term
    const term = _compactIri(activeCtx, value['@id'], null, {
      vocab: true
    });
    if (term in activeCtx.mappings && activeCtx.mappings[term] && activeCtx.mappings[term]['@id'] == value['@id']) {
      // prefer @vocab
      prefs.push.apply(prefs, ['@vocab', '@id']);
    } else {
      // prefer @id
      prefs.push.apply(prefs, ['@id', '@vocab']);
    }
  } else {
    prefs.push(typeOrLanguageValue);
  }
  prefs.push('@none');

  const containerMap = activeCtx.inverse[iri];
  for (let ci = 0; ci < containers.length; ++ci) {
    // if container not available in the map, continue
    const container = containers[ci];
    if (!(container in containerMap)) continue;

    const typeOrLanguageValueMap = containerMap[container][typeOrLanguage];
    for (let pi = 0; pi < prefs.length; ++pi) {
      // if type/language option not available in the map, continue
      const pref = prefs[pi];
      if (!(pref in typeOrLanguageValueMap)) continue;

      // select term
      return typeOrLanguageValueMap[pref];
    }
  }

  return null;
}

/**
 * Gets the initial context.
 *
 * @param options the options to use:
 *          [base] the document base IRI.
 *
 * @return the initial context.
 */
function _getInitialContext(options) {
  var base = jsonld.url.parse(options.base || '');
  return {
    '@base': base,
    mappings: {},
    inverse: null,
    getInverse: _createInverseContext,
    clone: _cloneActiveContext
  };

  /**
   * Generates an inverse context for use in the compaction algorithm, if
   * not already generated for the given active context.
   *
   * @return the inverse context.
   */
  function _createInverseContext() {
    var activeCtx = this;

    // lazily create inverse
    if(activeCtx.inverse) {
      return activeCtx.inverse;
    }
    var inverse = activeCtx.inverse = {};

    // handle default language
    var defaultLanguage = activeCtx['@language'] || '@none';

    // create term selections for each mapping in the context, ordered by
    // shortest and then lexicographically least
    var mappings = activeCtx.mappings;
    var terms = Object.keys(mappings).sort(_compareShortestLeast);
    for(var i = 0; i < terms.length; ++i) {
      var term = terms[i];
      var mapping = mappings[term];
      if(mapping === null) {
        continue;
      }

      var container = mapping['@container'] || '@none';

      // iterate over every IRI in the mapping
      var ids = mapping['@id'];
      if(!Array.isArray(ids)) {
        ids = [ids];
      }
      for(var ii = 0; ii < ids.length; ++ii) {
        var iri = ids[ii];
        var entry = inverse[iri];

        // initialize entry
        if(!entry) {
          inverse[iri] = entry = {};
        }

        // add new entry
        if(!entry[container]) {
          entry[container] = {
            '@language': {},
            '@type': {}
          };
        }
        entry = entry[container];

        if(mapping.reverse) {
          // term is preferred for values using @reverse
          _addPreferredTerm(mapping, term, entry['@type'], '@reverse');
        } else if('@type' in mapping) {
          // term is preferred for values using specific type
          _addPreferredTerm(mapping, term, entry['@type'], mapping['@type']);
        } else if('@language' in mapping) {
          // term is preferred for values using specific language
          var language = mapping['@language'] || '@null';
          _addPreferredTerm(mapping, term, entry['@language'], language);
        } else {
          // term is preferred for values w/default language or no type and
          // no language
          // add an entry for the default language
          _addPreferredTerm(mapping, term, entry['@language'], defaultLanguage);

          // add entries for no type and no language
          _addPreferredTerm(mapping, term, entry['@type'], '@none');
          _addPreferredTerm(mapping, term, entry['@language'], '@none');
        }
      }
    }

    return inverse;
  }

  /**
   * Adds the term for the given entry if not already added.
   *
   * @param mapping the term mapping.
   * @param term the term to add.
   * @param entry the inverse context typeOrLanguage entry to add to.
   * @param typeOrLanguageValue the key in the entry to add to.
   */
  function _addPreferredTerm(mapping, term, entry, typeOrLanguageValue) {
    if(!(typeOrLanguageValue in entry)) {
      entry[typeOrLanguageValue] = term;
    }
  }

  /**
   * Clones an active context, creating a child active context.
   *
   * @return a clone (child) of the active context.
   */
  function _cloneActiveContext() {
    var child = {};
    child['@base'] = this['@base'];
    child.mappings = _clone(this.mappings);
    child.clone = this.clone;
    child.inverse = null;
    child.getInverse = this.getInverse;
    if('@language' in this) {
      child['@language'] = this['@language'];
    }
    if('@vocab' in this) {
      child['@vocab'] = this['@vocab'];
    }
    return child;
  }
}

function jsonldcompact(input, ctx) {
  return new Promise((accept, reject) => {
    jsonldraw.compact(input, ctx, (err, compacted, ctx) => {
      if (err) return reject(err)
      return accept({ ctx, compacted })
    })
  })
}

/**
 * Adds a value to a subject. If the value is an array, all values in the
 * array will be added.
 *
 * @param subject the subject to add the value to.
 * @param property the property that relates the value to the subject.
 * @param value the value to add.
 * @param [options] the options to use:
 *        [propertyIsArray] true if the property is always an array, false
 *          if not (default: false).
 *        [allowDuplicate] true to allow duplicates, false not to (uses a
 *          simple shallow comparison of subject ID or value) (default: true).
 */
function addValue(subject, property, value, options) {
  options = options || {};
  if(!('propertyIsArray' in options)) {
    options.propertyIsArray = false;
  }
  if(!('allowDuplicate' in options)) {
    options.allowDuplicate = true;
  }

  if(Array.isArray(value)) {
    if(value.length === 0 && options.propertyIsArray &&
      !(property in subject)) {
      subject[property] = [];
    }
    for(var i = 0; i < value.length; ++i) {
      addValue(subject, property, value[i], options);
    }
  } else if(property in subject) {
    // check if subject already has value if duplicates not allowed
    var hasValue = (!options.allowDuplicate &&
      jsonld.hasValue(subject, property, value));

    // make property an array if value not present or always an array
    if(!Array.isArray(subject[property]) &&
      (!hasValue || options.propertyIsArray)) {
      subject[property] = [subject[property]];
    }

    // add new value
    if(!hasValue) {
      subject[property].push(value);
    }
  } else {
    // add new value as set or single value
    subject[property] = options.propertyIsArray ? [value] : value;
  }
};
