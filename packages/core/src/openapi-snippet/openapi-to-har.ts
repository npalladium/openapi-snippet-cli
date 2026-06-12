// @ts-nocheck
/**
 * Translates given OpenAPI document to an array of HTTP Archive (HAR) 1.2 Request Object.
 * See more:
 *  - http://swagger.io/specification/
 *  - http://www.softwareishard.com/blog/har-12-spec/#request
 *
 * Example HAR Request Object:
 * "request": {
 *   "method": "GET",
 *   "url": "http://www.example.com/path/?param=value",
 *   "httpVersion": "HTTP/1.1",
 *   "cookies": [],
 *   "headers": [],
 *   "queryString" : [],
 *   "postData" : {},
 *   "headersSize": 150,
 *   "bodySize": 0,
 *   "comment": ""
 * }
 */

import * as OpenAPISampler from 'openapi-sampler'

type HarParameterObject = { name: string; value: string }

/** Options controlling how sample values are generated for snippets. */
type SampleOptions = { smartSamples?: boolean }

/** The literal value openapi-sampler emits for a plain `string` with no
 *  format/enum/example/default. We treat it as the "unfilled" marker. */
const SAMPLER_STRING_DEFAULT = 'string'

/**
 * Pick an author-provided example off a media-type object, parameter, or
 * schema: prefers `example`, else the first entry of `examples` (resolving a
 * `$ref` and unwrapping its `.value`). Returns undefined when none is present.
 */
const pickExample = (openApi, container) => {
  if (!container || typeof container !== 'object') return undefined
  if (typeof container.example !== 'undefined') return container.example
  if (container.examples && typeof container.examples === 'object') {
    let first = Object.values(container.examples)[0]
    if (first && typeof first.$ref === 'string' && /^#/.test(first.$ref)) {
      first = resolveRefMemoized(openApi, first.$ref)
    }
    if (first && typeof first === 'object' && 'value' in first) return first.value
    return first
  }
  return undefined
}

// Ordered name->value rules. First matching pattern wins, so more specific
// patterns (e.g. first/last name) precede the generic `name`.
const STRING_HEURISTICS: [RegExp, string][] = [
  [/e-?mail/, 'user@example.com'],
  [/url|uri|href|link|website|endpoint/, 'https://example.com'],
  [/(^|_)id$|_id$|uuid|guid/, '3fa85f64-5717-4562-b3fc-2c963f66afa6'],
  [/phone|mobile|msisdn/, '+15555550123'],
  [/first.?name/, 'John'],
  [/last.?name|surname/, 'Doe'],
  [/name/, 'John Doe'],
  [/datetime|timestamp|date.?time/, '2019-08-24T14:15:22Z'],
  [/date/, '2019-08-24'],
  [/time/, '14:15:22'],
  [/currency/, 'USD'],
  [/country/, 'US'],
  [/zip|postal/, '94105'],
  [/city/, 'San Francisco'],
  [/state|province|region/, 'CA'],
  [/address|street/, '123 Main St'],
  [/colou?r/, 'blue'],
  [/timezone|time.?zone/, 'America/Los_Angeles'],
  [/lang|locale/, 'en-US'],
  [/token|secret|password|api.?key/, 'REPLACE_ME'],
  [/status/, 'active'],
  [/type|kind|category/, 'default'],
]

/** Infer a realistic placeholder for an un-annotated string from its key. */
const guessStringForKey = (key) => {
  const k = String(key).toLowerCase()
  for (const [pattern, value] of STRING_HEURISTICS) {
    if (pattern.test(k)) return value
  }
  // Free-text-ish fields read better with the original key echoed back.
  if (/description|summary|comment|message|title|label|note|text/.test(k)) return `Sample ${key}`
  return SAMPLER_STRING_DEFAULT
}

/**
 * Replace the sampler's neutral `'string'` default with a value inferred from
 * the enclosing property name. Only values that are exactly `'string'` are
 * touched, so real samples (formats, enums, author examples) are preserved.
 */
const applyStringHeuristics = (value, key) => {
  if (Array.isArray(value)) return value.map((v) => applyStringHeuristics(v, key))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = applyStringHeuristics(v, k)
    return out
  }
  if (value === SAMPLER_STRING_DEFAULT && typeof key !== 'undefined') return guessStringForKey(key)
  return value
}

/** Sample a schema, applying name-based heuristics when `smartSamples` is on. */
const sampleSchema = (schema, openApi, options: SampleOptions = {}) => {
  const sample = OpenAPISampler.sample(schema, { skipReadOnly: true }, openApi)
  return options.smartSamples ? applyStringHeuristics(sample, undefined) : sample
}

const createHar = (openApi, path, method, queryParamValues = {}, options: SampleOptions = {}) => {
  const baseUrl = getBaseUrl(openApi, path, method)

  const baseHar = {
    method: method.toUpperCase(),
    // getFullPath substitutes path parameters with their example/sample value;
    // any parameter that still couldn't be resolved keeps its `{name}` brace,
    // which we percent-encode so the URL stays syntactically valid.
    url: (baseUrl + getFullPath(openApi, path, method, options)).replace(
      /\{([^}]+)\}/g,
      (_, n) => `%7B${n}%7D`,
    ),
    headers: getHeadersArray(openApi, path, method, options),
    queryString: getQueryStrings(openApi, path, method, queryParamValues, options),
    httpVersion: 'HTTP/1.1',
    cookies: getCookies(openApi, path, method, options),
    headersSize: 0,
    bodySize: 0,
  }

  let hars = []

  // get payload data, if available:
  const postDatas = getPayloads(openApi, path, method, options)

  // For each postData create a snippet
  if (postDatas.length > 0) {
    for (const i in postDatas) {
      const postData = postDatas[i]
      const copiedHar = JSON.parse(JSON.stringify(baseHar))
      copiedHar.postData = postData
      copiedHar.comment = postData.mimeType
      copiedHar.headers.push({
        name: 'content-type',
        value: postData.mimeType,
      })
      hars.push(copiedHar)
    }
  } else {
    hars = [baseHar]
  }

  return hars
}

const isPrimitive = (value) => {
  if (value === null) return true
  const valueType = typeof value
  if (valueType === 'function' || valueType === 'object') return false
  return true
}

const getPrefix = (style) => {
  if (style === 'label') {
    return '.'
  }
  if (style === 'matrix') {
    return ';'
  }
  return ''
}

const getSeparator = (style) => {
  if (style === 'label') return '.'
  if (style === 'matrix') return ';'
  return ','
}

const getParamId = (style, name) => {
  if (style === 'matrix') return `${name}=`
  return ''
}

const getDefaultStyleForLocation = (location) => {
  if (location === 'path' || location === 'header') {
    return 'simple'
  }
  if (location === 'query' || location === 'cookie') {
    return 'form'
  }
}

const getDefaultExplodeForStyle = (style) => style === 'form'

const getArrayElementSeparator = (style) => {
  let separator = ','
  if (style === 'spaceDelimited') {
    separator = ' '
  } else if (style === 'pipeDelimited') {
    separator = '|'
  }
  return separator
}

const objectJoin = (obj, keyValueSeparator = ',', pairSeparator = ',') =>
  Object.entries(obj)
    .map(([k, v]) => `${k}${keyValueSeparator}${v}`)
    .join(pairSeparator)

const pushPrimitive = (objects, name, value) => objects.push({ name, value: String(value) })

const pushExplodedArray = (objects, name, value) => {
  for (const entry of value) {
    pushPrimitive(objects, name, entry)
  }
}

const pushJoinedArray = (objects, name, value, separator) => {
  objects.push({ name, value: value.join(separator) })
}

const pushDeepObject = (objects, name, value) => {
  for (const [k, v] of Object.entries(value)) {
    objects.push({ name: `${name}[${k}]`, value: String(v) })
  }
}

const pushExplodedObject = (objects, value) => {
  for (const [k, v] of Object.entries(value)) {
    objects.push({ name: k, value: String(v) })
  }
}

const pushFlatObject = (objects, name, value) => {
  objects.push({ name, value: objectJoin(value) })
}

/**
 * Returns an array of HAR parameter objects for the specified parameter and value.
 *
 * See https://swagger.io/docs/specification/serialization for the logic of how value of
 * the return objects are calculated
 */
const createHarParameterObjects = ({ name, in: location, style, explode }, value) => {
  if (!name || !location || typeof value === 'undefined') {
    throw new Error('Required parameters missing')
  }

  const prefix = getPrefix(style)
  const paramId = getParamId(style, name)

  if (isPrimitive(value)) {
    return [{ name, value: prefix + paramId + value }]
  }

  const objects = []
  const resolvedStyle = style ?? getDefaultStyleForLocation(location)
  const resolvedExplode = explode ?? getDefaultExplodeForStyle(resolvedStyle)

  if (location === 'query' || location === 'cookie') {
    collectQueryOrCookieParams(objects, name, value, resolvedStyle, resolvedExplode)
  } else if (location === 'path' || location === 'header') {
    collectPathOrHeaderParams(objects, name, value, resolvedStyle, resolvedExplode, prefix, paramId)
  }

  return objects
}

const collectQueryOrCookieParams = (objects, name, value, style, explode) => {
  const separator = getArrayElementSeparator(style)
  if (Array.isArray(value)) {
    if (explode) {
      pushExplodedArray(objects, name, value)
    } else {
      pushJoinedArray(objects, name, value, separator)
    }
    return
  }
  if (value && typeof value === 'object') {
    if (style === 'deepObject') {
      pushDeepObject(objects, name, value)
    } else if (explode) {
      pushExplodedObject(objects, value)
    } else {
      pushFlatObject(objects, name, value)
    }
  }
}

const collectPathOrHeaderParams = (objects, name, value, style, explode, prefix, paramId) => {
  const separator = getSeparator(style)

  if (Array.isArray(value)) {
    objects.push({
      name,
      value: prefix + paramId + value.join(explode ? separator + paramId : ','),
    })
    return
  }
  if (value && typeof value === 'object') {
    if (explode) {
      objects.push({
        name,
        value: prefix + objectJoin(value, '=', separator),
      })
    } else {
      objects.push({
        name,
        value: prefix + paramId + objectJoin(value),
      })
    }
  }
}

const getPayloads = (openApi, path, method, options: SampleOptions = {}) => {
  if (typeof openApi.paths[path][method].parameters !== 'undefined') {
    for (const param of openApi.paths[path][method].parameters) {
      if (
        typeof param.in !== 'undefined' &&
        param.in.toLowerCase() === 'body' &&
        typeof param.schema !== 'undefined'
      ) {
        try {
          const example = pickExample(openApi, param)
          const sample =
            typeof example !== 'undefined' ? example : sampleSchema(param.schema, openApi, options)
          return [
            {
              mimeType: 'application/json',
              text: JSON.stringify(sample),
            },
          ]
        } catch (err) {
          console.log(err)
          return null
        }
      }
    }
  }

  let requestBody = openApi.paths[path][method].requestBody
  if (requestBody?.$ref) {
    requestBody = resolveRefMemoized(openApi, requestBody.$ref)
  }

  return collectRequestBodyPayloads(openApi, requestBody, options)
}

const collectRequestBodyPayloads = (openApi, requestBody, options: SampleOptions = {}) => {
  const payloads = []
  if (!requestBody?.content) return payloads

  for (const type of [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ]) {
    const content = requestBody.content[type]
    if (!content) continue
    // Prefer an author-provided example (media-type level), then the schema's
    // own example via the sampler. Skip the type only when neither exists.
    const example = pickExample(openApi, content)
    let sample: unknown
    if (typeof example !== 'undefined') {
      sample = example
    } else if (content.schema) {
      sample = sampleSchema(content.schema, openApi, options)
    } else {
      continue
    }
    if (type === 'application/json') {
      payloads.push({ mimeType: type, text: JSON.stringify(sample) })
    } else if (type === 'multipart/form-data') {
      appendMultipartPayload(payloads, type, sample)
    } else if (type === 'application/x-www-form-urlencoded') {
      appendFormUrlencodedPayload(payloads, type, sample)
    }
  }
  return payloads
}

const appendMultipartPayload = (payloads, type, sample) => {
  if (sample === undefined) return
  const params = []
  for (const key of Object.keys(sample)) {
    const raw = sample[key]
    const value = typeof raw !== 'string' ? JSON.stringify(raw) : raw
    params.push({ name: key, value })
  }
  payloads.push({ mimeType: type, params })
}

const appendFormUrlencodedPayload = (payloads, _type, sample) => {
  if (sample === undefined) return
  const params: Array<{ name: string; value: string }> = []
  for (const key of Object.keys(sample)) {
    params.push({
      name: encodeURIComponent(key).replace(/%20/g, '+'),
      value: encodeURIComponent(sample[key]).replace(/%20/g, '+'),
    })
  }
  payloads.push({
    mimeType: 'application/x-www-form-urlencoded',
    params,
    text: params.map((p) => `${p.name}=${p.value}`).join('&'),
  })
}

const getBaseUrl = (openApi, path, method) => {
  if (openApi.paths[path][method].servers?.length > 0)
    return openApi.paths[path][method].servers[0].url
  if (openApi.paths[path].servers?.length > 0) return openApi.paths[path].servers[0].url
  if (openApi.servers?.length > 0) return openApi.servers[0].url

  return buildLegacyBaseUrl(openApi)
}

const buildLegacyBaseUrl = (openApi) => {
  const scheme = typeof openApi.schemes !== 'undefined' ? openApi.schemes[0] : 'http'
  const host = openApi.host
  const basePath = !openApi.basePath || openApi.basePath === '/' ? '' : openApi.basePath
  return `${scheme}://${host}${basePath}`
}

const getParameterValues = (openApi, param, location, values, options: SampleOptions = {}) => {
  // Resolve the most specific value available, in priority order:
  // caller override -> example/examples -> schema.example -> default ->
  // a generated sample of the schema. Only when none of these yield a value
  // do we fall back to the literal placeholder.
  let value: unknown
  if (values && typeof values[param.name] !== 'undefined') {
    value = values[param.name]
  } else {
    const example = pickExample(openApi, param)
    if (typeof example !== 'undefined') value = example
  }
  if (typeof value === 'undefined' && param.schema && typeof param.schema.example !== 'undefined') {
    value = param.schema.example
  }
  if (typeof value === 'undefined' && typeof param.default !== 'undefined') {
    value = param.default
  }
  if (typeof value === 'undefined' && typeof param.schema !== 'undefined') {
    try {
      value = sampleSchema(param.schema, openApi, options)
    } catch {
      // fall through to the literal placeholder below
    }
  }
  if (typeof value === 'undefined') {
    value =
      location === 'path'
        ? `{${param.name}}`
        : `SOME_${(param.type || param.schema?.type || 'STRING').toUpperCase()}_VALUE`
  }
  // A plain-string sample comes back as the neutral 'string'; under smart
  // samples, infer something realistic from the parameter name.
  if (options.smartSamples && value === SAMPLER_STRING_DEFAULT) {
    value = guessStringForKey(param.name)
  }

  return createHarParameterObjects(param, value)
}

/**
 * Parse parameter object into query string objects
 */
const parseParametersToQuery = (
  openApi,
  parameters,
  location,
  values,
  options: SampleOptions = {},
) => {
  /** @type {Object.<string, HarParameterObject[]>} */
  const queryStrings: Record<string, HarParameterObject[]> = {}

  for (let param of parameters) {
    if (typeof param.$ref === 'string' && /^#/.test(param.$ref)) {
      param = resolveRefMemoized(openApi, param.$ref)
    }
    if (typeof param.schema !== 'undefined') {
      if (typeof param.schema.$ref === 'string' && /^#/.test(param.schema.$ref)) {
        param.schema = resolveRefMemoized(openApi, param.schema.$ref)
        if (typeof param.schema.type === 'undefined') {
          // many schemas don't have an explicit type
          param.schema.type = 'object'
        }
      }
    }
    if (typeof param.in !== 'undefined' && param.in.toLowerCase() === location) {
      // param.name is a safe key, because the spec defines
      // that name MUST be unique
      queryStrings[param.name] = getParameterValues(openApi, param, location, values, options)
    }
  }

  return queryStrings
}

/**
 * Examines all of the parameters in the specified path and operation looking
 * for those of the specific `location` specified.
 */
const getParameterCollectionIn = (
  openApi,
  path,
  method,
  location,
  values = {},
  options: SampleOptions = {},
) => {
  /** @type {Object.<string, HarParameterObject[]>} */
  let pathParameters: Record<string, HarParameterObject[]> = {}

  /** @type {Object.<string, HarParameterObject[]>} */
  let operationParameters: Record<string, HarParameterObject[]> = {}

  // First get any parameters from the path
  if (typeof openApi.paths[path].parameters !== 'undefined') {
    pathParameters = parseParametersToQuery(
      openApi,
      openApi.paths[path].parameters,
      location,
      values,
      options,
    )
  }

  if (typeof openApi.paths[path][method].parameters !== 'undefined') {
    operationParameters = parseParametersToQuery(
      openApi,
      openApi.paths[path][method].parameters,
      location,
      values,
      options,
    )
  }

  // Merge parameters, with method overriding path
  // from the spec:
  // If a parameter is already defined at the Path Item, the new definition will override
  // it but can never remove it.
  // https://swagger.io/specification/

  /** @type {Object.<string, HarParameterObject[]>} */
  const queryStrings: Record<string, HarParameterObject[]> = Object.assign(
    pathParameters,
    operationParameters,
  )

  // Convert the list of lists in Object.values(queryStrings) into a list

  return Object.values(queryStrings).flat()
}

/**
 * Get array of objects describing the query parameters for a path and method
 * pair described in the given OpenAPI document.
 */
const getQueryStrings = (
  openApi,
  path,
  method,
  values,
  options: SampleOptions = {},
): HarParameterObject[] => getParameterCollectionIn(openApi, path, method, 'query', values, options)

/**
 * Return the path with the parameters example values used if specified.
 */
const getFullPath = (openApi, path, method, options: SampleOptions = {}) => {
  let fullPath = path

  const pathParameters = getParameterCollectionIn(openApi, path, method, 'path', {}, options)
  pathParameters.forEach(({ name, value }) => {
    fullPath = fullPath.replace(`{${name}}`, value)
  })

  return fullPath
}

/**
 * Get an array of objects providing sample values for cookies
 */
const getCookies = (openApi, path, method, options: SampleOptions = {}) =>
  getParameterCollectionIn(openApi, path, method, 'cookie', {}, options)

/**
 * Get an array of objects describing the header for a path and method pair
 * described in the given OpenAPI document.
 */
const getHeadersArray = (openApi, path, method, options: SampleOptions = {}) => {
  const headers = []
  const pathObj = openApi.paths[path][method]

  headers.push(...collectAcceptHeaders(pathObj))
  headers.push(...getParameterCollectionIn(openApi, path, method, 'header', {}, options))
  headers.push(...collectAuthHeaders(openApi, pathObj))

  return headers
}

const collectAcceptHeaders = (pathObj) => {
  const headers = []
  if (typeof pathObj.consumes === 'undefined') return headers
  for (const type of pathObj.consumes) {
    headers.push({ name: 'accept', value: type })
  }
  return headers
}

const collectAuthHeaders = (openApi, pathObj) => {
  const auth = resolveAuth(openApi, pathObj)
  const headers = []
  if (auth.basic) {
    headers.push({ name: 'Authorization', value: 'Basic REPLACE_BASIC_AUTH' })
  } else if (auth.apiKey) {
    headers.push({ name: auth.apiKey.name, value: 'REPLACE_KEY_VALUE' })
  } else if (auth.oauth) {
    headers.push({ name: 'Authorization', value: 'Bearer REPLACE_BEARER_TOKEN' })
  }
  return headers
}

const resolveAuth = (openApi, pathObj) => {
  const auth = { basic: null, apiKey: null, oauth: null }
  const security = pathObj.security ?? openApi.security
  if (typeof security === 'undefined') return auth

  for (const secEntry of security) {
    const secScheme = Object.keys(secEntry)[0]
    const secDefinition = findSecurityDefinition(openApi, secScheme)
    if (!secDefinition) continue
    applySecurityDefinition(auth, secScheme, secDefinition)
  }
  return auth
}

const findSecurityDefinition = (openApi, secScheme) => {
  return (
    openApi.securityDefinitions?.[secScheme] ?? openApi.components?.securitySchemes?.[secScheme]
  )
}

const applySecurityDefinition = (auth, secScheme, secDefinition) => {
  const authType = secDefinition.type.toLowerCase()
  const authScheme = deriveAuthScheme(secDefinition, authType)
  switch (authType) {
    case 'basic':
      auth.basic = secScheme
      break
    case 'apikey':
      if (secDefinition.in === 'header') auth.apiKey = secDefinition
      break
    case 'oauth2':
      auth.oauth = secScheme
      break
    case 'http':
      if (authScheme === 'bearer') auth.oauth = secScheme
      if (authScheme === 'basic') auth.basic = secScheme
      break
  }
}

const deriveAuthScheme = (secDefinition, authType) => {
  if (secDefinition.scheme == null) return null
  if (authType === 'apikey' || authType === 'oauth2') return null
  return secDefinition.scheme.toLowerCase()
}

/**
 * Produces array of HAR files for given OpenAPI document
 */
const openApiToHarList = (openApi, options: SampleOptions = {}) => {
  try {
    // iterate openApi and create har objects:
    const harList = []
    for (const path in openApi.paths) {
      for (const method in openApi.paths[path]) {
        const url = getBaseUrl(openApi, path, method) + path
        const hars = createHar(openApi, path, method, {}, options)
        // need to push multiple here
        harList.push({
          method: method.toUpperCase(),
          url: url,
          description: openApi.paths[path][method].description || 'No description available',
          hars: hars,
        })
      }
    }

    return harList
  } catch (e) {
    console.log(e)
  }
}

/**
 * Returns the value referenced in the given reference string
 */
const resolveRef = (openApi, ref) => {
  const parts = ref.split('/')

  if (parts.length <= 1) return {} // = 3

  const recursive = (obj, index) => {
    if (index + 1 < parts.length) {
      // index = 1
      const newCount = index + 1
      return recursive(obj[parts[index]], newCount)
    }
    return obj[parts[index]]
  }
  return recursive(openApi, 1)
}

// Build a memoized resolver per OpenAPI document. The first call to
// resolveRefMemoized walks the doc once to index every JSON-pointer
// path; subsequent calls look up by path. Cuts per-endpoint resolveRef
// cost from O(depth) to O(1).
const refCache = new WeakMap()
const resolveRefMemoized = (openApi, ref) => {
  let cache = refCache.get(openApi)
  if (!cache) {
    cache = new Map()
    refCache.set(openApi, cache)
  }
  const cached = cache.get(ref)
  if (cached !== undefined) return cached
  const value = resolveRef(openApi, ref)
  cache.set(ref, value)
  return value
}

export { openApiToHarList as getAll, createHar as getEndpoint, createHarParameterObjects }
