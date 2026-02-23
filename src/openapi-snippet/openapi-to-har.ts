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
 *   "headersSize" : 150,
 *   "bodySize" : 0,
 *   "comment" : ""
 * }
 */

import * as OpenAPISampler from 'openapi-sampler'

type HarParameterObject = { name: string; value: string }

/**
 * Create HAR Request object for path and method pair described in given OpenAPI
 * document.
 *
 * @param  {Object} openApi           OpenAPI document
 * @param  {string} path              Key of the path
 * @param  {string} method            Key of the method
 * @param  {Object} queryParamValues  Optional: Values for the query parameters if present
 * @return {array}                    List of HAR Request objects for the endpoint
 */
const createHar = function (openApi: any, path: string, method: string, queryParamValues: any): Array<any> {
  // if the operational parameter is not provided, set it to empty object
  if (typeof queryParamValues === 'undefined') {
    queryParamValues = {}
  }

  const baseUrl = getBaseUrl(openApi, path, method)

  const baseHar = {
    method: method.toUpperCase(),
    url: (baseUrl + getFullPath(openApi, path, method)).replace(/\{([^}]+)\}/g, (_, n) => `%7B${n}%7D`),
    headers: getHeadersArray(openApi, path, method),
    queryString: getQueryStrings(openApi, path, method, queryParamValues),
    httpVersion: 'HTTP/1.1',
    cookies: getCookies(openApi, path, method),
    headersSize: 0,
    bodySize: 0,
  }

  let hars = []

  // get payload data, if available:
  const postDatas = getPayloads(openApi, path, method)

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

/**
 * Tests `value` to see if it is a primitive.
 * @param {*} value - The value to test
 * @returns {boolean} - `true` if `value` is a primitive, `false` otherwise
 */
const isPrimitive = function (value: any): boolean {
  if (value === null) return true
  const valueType = typeof value
  if (valueType === 'function' || valueType === 'object') return false
  return true
}

/**
 * Returns a string that is used as a prefix before a value in a path parameter
 * @param {string} style
 * @returns {string} - Returns `.` for label style and `;` for matrix style. Returns '' for any other input.
 */
const getPrefix = function (style: string): string {
  if (style === 'label') {
    return '.'
  }
  if (style === 'matrix') {
    return ';'
  }
  return ''
}

/**
 * Returns the separator character used between elements of a path parameter
 * Returns '.' for label style, ';' for matrix style and ',' for all others
 * @param {string} style
 * @returns
 */
const getSeparator = function (style: string) {
  if (style === 'label') return '.'
  if (style === 'matrix') return ';'
  return ','
}

/**
 * Returns a "parameter identifier" used in matrix style path parameters. For all other styles
 * it returns ''
 * @param {string} style
 * @param {string} name - The parameter name
 * @returns {string} - The empty string if `style` is not `matrix`, else a string in the format `;{name}=`
 */
const getParamId = function (style: string, name: string): string {
  if (style === 'matrix') return `${name}=`
  return ''
}

/**
 * Returns the default style for the location per OpenAPI 3.0.3 spec
 * @param {*} location
 * @returns
 */
const getDefaultStyleForLocation = function (location: any): 'simple' | 'form' | undefined {
  if (location === 'path' || location === 'header') {
    return 'simple'
  } if (location === 'query' || location === 'cookie') {
    return 'form'
  }
}

/**
 * Returns the default value of explode for the given style per OpenAPI 3.0.3 spec
 * @param {*} style
 * @returns
 */
const getDefaultExplodeForStyle = function (style: any): boolean {
  return style === 'form'
}

/**
 * Returns the correct array element separator for unexploded query parameters
 * based on style. If style is spaceDelimited this returns `%20` (the encoded string for
 * space character). If style is pipeDelimited this returns '|'; else it returns ','
 * @param {*} style
 * @returns
 */
const getArrayElementSeparator = function (style: string): string {
  let separator = ','
  if (style === 'spaceDelimited') {
    separator = ' '
  } else if (style === 'pipeDelimited') {
    separator = '|'
  }
  return separator
}

/**
 * Returns a string representation of `obj`. Each key value pair is separated by
 * a `keyValueSeparator` and each pair is separated by a `pairSeparator`.
 *
 * @param {*} obj
 * @param {*} keyValueSeparator
 * @param {*} pairSeparator
 * @example
 * // returns "firstName=Alex,age=34"
 * objectJoin({ firstName: 'Alex', age: 34 }, '=', ',')
 * @returns
 */
const objectJoin = function (
  obj: any,
  keyValueSeparator = ',',
  pairSeparator = ','
) {
  return Object.entries(obj)
  .map(([k, v]) => `${k}${keyValueSeparator}${v}`)
  .join(pairSeparator)
}

/**
 * @typedef {object} HarParameterObject - An object that describes a parameter in a HAR
 * @property {string} name - The name of the parameter
 * @property {string} value - The value of the parameter
 */

/**
 * Returns an array of HAR parameter objects for the specified parameter and value.
 *
 * While it is quite often that a singleton array is returned, when `explode` is
 * true multiple objects may be returned.
 *
 * See https://swagger.io/docs/specification/serialization for the logic of how value of
 * the return objects are calculated
 *
 * @param {Object} parameter  - An OpenAPI Parameter object
 * @param {string} name       - The name of the parameter
 * @param {string} in         - One of the values: `path`, `query`, `header`, `cookie`
 * @param {string} [style]    - Optional: One of the OpenAPI styles {e.g. form, simple, label, matrix, ...}
 * @param {boolean} [explode] - Optional: Whether or not arrays and objects should be exploded
 * @param {*}      value      - The value to use in the query string object. Since `parameter`
 *                              has many properties that could be a candidate for the value this
 *                              parameter is used to explicitly state which value should be used.
 * @return {HarParameterObject[]} - An array of query string objects
 */
const createHarParameterObjects = function (
  {name, in: location, style, explode}: any,
  value: string
) {
  if (!name || !location || typeof value === 'undefined') {
    throw new Error('Required parameters missing')
  }

  const prefix = getPrefix(style)
  const paramId = getParamId(style, name)

  if (isPrimitive(value)) {
    return [{name, value: prefix + paramId + value}]
  }

  const objects = []
  style = style ?? getDefaultStyleForLocation(location)
  explode = explode ?? getDefaultExplodeForStyle(style)

  if (location === 'query' || location === 'cookie') {
    const separator = getArrayElementSeparator(style)
    if (Array.isArray(value)) {
      if (explode) {
        objects.push(
          ...value.map(entry => {
            return {name, value: String(entry)}
          })
        )
      } else {
        objects.push({name, value: value.join(separator)})
      }
    } else if (value && typeof value === 'object') {
      if (style === 'deepObject') {
        objects.push(
          ...Object.entries(value).map(([k, v]) => {
            return {name: `${name}[${k}]`, value: String(v)}
          })
        )
      } else if (explode) {
        objects.push(
          ...Object.entries(value).map(([k, v]) => {
            return {name: k, value: String(v)}
          })
        )
      } else {
        objects.push({
          name,
          value: objectJoin(value),
        })
      }
    }
  } else if (location === 'path' || location === 'header') {
    const separator = getSeparator(style)

    if (Array.isArray(value)) {
      objects.push({
        name,
        value:
          prefix + paramId + value.join(explode ? separator + paramId : ','),
      })
    } else if (value && typeof value === 'object') {
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

  return objects
}

/**
 * Get the payload definition for the given endpoint (path + method) from the
 * given OAI specification. References within the payload definition are
 * resolved.
 *
 * @param  {object} openApi
 * @param  {string} path
 * @param  {string} method
 * @return {array}  A list of payload objects
 */
const getPayloads = function (openApi: any, path: string, method: string): Array<any> | null {
  if (typeof openApi.paths[path][method].parameters !== 'undefined') {
    for (const param of openApi.paths[path][method].parameters) {
      if (
        typeof param.in !== 'undefined' &&
        param.in.toLowerCase() === 'body' &&
        typeof param.schema !== 'undefined'
      ) {
        try {
          const sample = OpenAPISampler.sample(
            param.schema,
            {skipReadOnly: true},
            openApi
          )
          return [
            {
              mimeType: 'application/json',
              text: JSON.stringify(sample),
            },
          ]
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log(err)
          return null
        }
      }
    }
  }

  let requestBody = openApi.paths[path][method].requestBody
  if (requestBody?.$ref) {
    requestBody = resolveRef(openApi, requestBody.$ref)
  }

  const payloads = []
  if (requestBody?.content) {
    [
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
    ].forEach(type => {
      const content = requestBody.content[type]
      if (content && content.schema) {
        const sample = OpenAPISampler.sample(
          content.schema,
          {skipReadOnly: true},
          openApi
        )
        if (type === 'application/json') {
          payloads.push({
            mimeType: type,
            text: JSON.stringify(sample),
          })
        } else if (type === 'multipart/form-data') {
          if (sample !== undefined) {
            const params = []
            Object.keys(sample).forEach(key => {
              let value = sample[key]
              if (typeof sample[key] !== 'string') {
                value = JSON.stringify(sample[key])
              }
              params.push({name: key, value: value})
            })
            payloads.push({
              mimeType: type,
              params: params,
            })
          }
        } else if (type === 'application/x-www-form-urlencoded') {
          if (sample === undefined) return

          const params: Array<{name: string; value: string}> = []
          Object.keys(sample).forEach(key =>
            params.push({
              name: encodeURIComponent(key).replace(/\%20/g, '+'),
              value: encodeURIComponent(sample[key]).replace(/\%20/g, '+'),
            })
          )

          payloads.push({
            mimeType: 'application/x-www-form-urlencoded',
            params: params,
            text: params.map(p => p.name + '=' + p.value).join('&'),
          })
        }
      }
    })
  }
  return payloads
}

/**
 * Gets the base URL constructed from the given openApi.
 *
 * @param  {Object} openApi OpenAPI document
 * @param path
 * @param method
 * @return {string}         Base URL
 */
const getBaseUrl = function (openApi: any, path: string, method: string): string {
  if (openApi.paths[path][method].servers?.length > 0)
    return openApi.paths[path][method].servers[0].url
  if (openApi.paths[path].servers?.length > 0) return openApi.paths[path].servers[0].url
  if (openApi.servers?.length > 0) return openApi.servers[0].url

  let baseUrl = ''
  if (typeof openApi.schemes !== 'undefined') {
    baseUrl += openApi.schemes[0]
  } else {
    baseUrl += 'http'
  }

  if (!openApi.basePath || openApi.basePath === '/') {
    baseUrl += '://' + openApi.host
  } else {
    baseUrl += '://' + openApi.host + openApi.basePath
  }

  return baseUrl
}

/**
 * Gets an object describing the parameters (header or query) in a given OpenAPI method
 * @param  {Object} openApi    OpenApi document
 * @param  {Object} param      parameter values to use in snippet
 * @param  {string} location   One of `path`, `header`, `query`, `cookie`
 * @param  {Object} values     Optional: query parameter values to use in the snippet if present
 * @return {HarParameterObject[]} Array of objects describing the parameters in a given OpenAPI method or path
 */
const getParameterValues = function (openApi: any, param: any, location: string, values: any): HarParameterObject[] {
  let value =
    'SOME_' + (param.type || param.schema?.type || 'STRING').toUpperCase() + '_VALUE'
  if (location === 'path') {
    // then default to the original place holder value (e.b. '{id}')
    value = `{${param.name}}`
  }

  if (values && typeof values[param.name] !== 'undefined') {
    value = values[param.name]
  } else if (typeof param.example !== 'undefined') {
    value = param.example
  } else if (typeof param.examples !== 'undefined') {
    let firstExample = Object.values(param.examples)[0]
    if (
      typeof firstExample.$ref === 'string' &&
      /^#/.test(firstExample.$ref)
    ) {
      firstExample = resolveRef(openApi, firstExample.$ref)
    }
    value = firstExample.value
  } else if (
    typeof param.schema !== 'undefined' &&
    typeof param.schema.example !== 'undefined'
  ) {
    value = param.schema.example
  } else if (typeof param.default !== 'undefined') {
    value = param.default
  }

  return createHarParameterObjects(param, value)
}

/**
 * Parse parameter object into query string objects
 *
 * @param  {Object} openApi    OpenApi document
 * @param  {Object} parameters Objects described in the document to parse into the query string
 * @param  {string} location   One of `path`, `query`, `header` or `cookie`
 * @param  {Object} values     Optional: query parameter values to use in the snippet if present
 * @return {Object.<string, HarParameterObject[]>} Object describing the parameters for a method or path.
 * Each key in the return object will have at least one entry it's is value array. But exploded values
 * in query parameters may have more than one.
 */
const parseParametersToQuery = function (
  openApi: any,
  parameters: any,
  location: string,
  values: any,
): { [s: string]: HarParameterObject[] } {
  /** @type {Object.<string, HarParameterObject[]>} */
  const queryStrings = {}

  for (let param of parameters) {
    if (typeof param.$ref === 'string' && /^#/.test(param.$ref)) {
      param = resolveRef(openApi, param.$ref)
    }
    if (typeof param.schema !== 'undefined') {
      if (
        typeof param.schema.$ref === 'string' &&
        /^#/.test(param.schema.$ref)
      ) {
        param.schema = resolveRef(openApi, param.schema.$ref)
        if (typeof param.schema.type === 'undefined') {
          // many schemas don't have an explicit type
          param.schema.type = 'object'
        }
      }
    }
    if (
      typeof param.in !== 'undefined' &&
      param.in.toLowerCase() === location
    ) {
      // param.name is a safe key, because the spec defines
      // that name MUST be unique
      queryStrings[param.name] = getParameterValues(
        openApi,
        param,
        location,
        values
      )
    }
  }

  return queryStrings
}

/**
 * Examines all of the parameters in the specified path and operation looking
 * for those of the specific `location` specified
 * It resolves any references to schemas or parameters as it does so.
 * It examines the `example`, `examples`, `schema.example` and `default`
 * keys looking for one sample value. It then returns an array of HAR
 * parameter objects
 * @param  {Object} openApi OpenAPI document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @param  {string} location One of `path`, `query`, `header`, `cookie`
 * @param values
 * @returns
 */
const getParameterCollectionIn = function (
  openApi: any,
  path: string,
  method: string,
  location: string,
  values: any,
) {
  // Set the optional parameter if it's not provided
  if (typeof values === 'undefined') {
    values = {}
  }

  /** @type {Object.<string, HarParameterObject[]>} */
  let pathParameters = {}

  /** @type {Object.<string, HarParameterObject[]>} */
  let operationParameters = {}

  // First get any parameters from the path
  if (typeof openApi.paths[path].parameters !== 'undefined') {
    pathParameters = parseParametersToQuery(
      openApi,
      openApi.paths[path].parameters,
      location,
      values
    )
  }

  if (typeof openApi.paths[path][method].parameters !== 'undefined') {
    operationParameters = parseParametersToQuery(
      openApi,
      openApi.paths[path][method].parameters,
      location,
      values
    )
  }

  // Merge parameters, with method overriding path
  // from the spec:
  // If a parameter is already defined at the Path Item, the new definition will override
  // it but can never remove it.
  // https://swagger.io/specification/

  /** @type {Object.<string, HarParameterObject[]} */
  const queryStrings = Object.assign(pathParameters, operationParameters)

  // Convert the list of lists in Object.values(queryStrings) into a list

  return Object.values(queryStrings).flatMap(entry => entry)
}

/**
 * Get array of objects describing the query parameters for a path and method
 * pair described in the given OpenAPI document.
 *
 * @param  {Object} openApi OpenApi document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @param  {Object} values  Optional: query parameter values to use in the snippet if present
 * @return {HarParameterObject[]} List of objects describing the query strings
 */
const getQueryStrings = function (openApi: any, path: string, method: string, values: any): HarParameterObject[] {
  return getParameterCollectionIn(openApi, path, method, 'query', values)
}

/**
 * Return the path with the parameters example values used if specified.
 *
 * @param  {Object} openApi OpenApi document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @return {string}         Full path including example values
 */
const getFullPath = function (openApi, path, method) {
  let fullPath = path

  const pathParameters = getParameterCollectionIn(
    openApi,
    path,
    method,
    'path'
  )
  pathParameters.forEach(({name, value}) => {
    fullPath = fullPath.replace('{' + name + '}', value)
  })

  return fullPath
}

/**
 * Get an array of objects providing sample values for cookies
 *
 * @param  {Object} openApi OpenAPI document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 */
const getCookies = function (openApi, path, method) {
  return getParameterCollectionIn(openApi, path, method, 'cookie')
}

/**
 * Get an array of objects describing the header for a path and method pair
 * described in the given OpenAPI document.
 *
 * @param  {Object} openApi OpenAPI document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @return {HarParameterObject[]} List of objects describing the header
 */
const getHeadersArray = function (openApi, path, method) {
  const headers = []
  const pathObj = openApi.paths[path][method]

  // 'accept' header:
  if (typeof pathObj.consumes !== 'undefined') {
    for (const type of pathObj.consumes) {
      headers.push({
        name: 'accept',
        value: type,
      })
    }
  }

  // headers defined in path object:
  headers.push(...getParameterCollectionIn(openApi, path, method, 'header'))

  // security:
  let basicAuthDef
  let apiKeyAuthDef
  let oauthDef
  if (typeof pathObj.security !== 'undefined') {
    for (const secEntry of pathObj.security) {
      const secScheme = Object.keys(secEntry)[0]
      const secDefinition = openApi.securityDefinitions ?
        openApi.securityDefinitions[secScheme] :
        openApi.components.securitySchemes[secScheme]
      if (!secDefinition) continue
      const authType = secDefinition.type.toLowerCase()
      let authScheme = null

      if (authType !== 'apikey' && secDefinition.scheme != null) {
        authScheme = secDefinition.scheme.toLowerCase()
      }

      switch (authType) {
      case 'basic':
        basicAuthDef = secScheme
        break
      case 'apikey':
        if (secDefinition.in === 'header') {
          apiKeyAuthDef = secDefinition
        }
        break
      case 'oauth2':
        oauthDef = secScheme
        break
      case 'http':
        switch (authScheme) {
        case 'bearer':
          oauthDef = secScheme
          break
        case 'basic':
          basicAuthDef = secScheme
          break
        }
        break
      }
    }
  } else if (typeof openApi.security !== 'undefined') {
    // Need to check OAS 3.0 spec about type http and scheme
    for (const secEntry of openApi.security) {
      const secScheme = Object.keys(secEntry)[0]
      const secDefinition = openApi.components.securitySchemes[secScheme]
      if (!secDefinition) continue
      const authType = secDefinition.type.toLowerCase()
      let authScheme = null

      if (authType !== 'apikey' && authType !== 'oauth2') {
        authScheme = secDefinition.scheme.toLowerCase()
      }

      switch (authType) {
      case 'http':
        switch (authScheme) {
        case 'bearer':
          oauthDef = secScheme
          break
        case 'basic':
          basicAuthDef = secScheme
          break
        }
        break
      case 'basic':
        basicAuthDef = secScheme
        break
      case 'apikey':
        if (secDefinition.in === 'header') {
          apiKeyAuthDef = secDefinition
        }
        break
      case 'oauth2':
        oauthDef = secScheme
        break
      }
    }
  }

  if (basicAuthDef) {
    headers.push({
      name: 'Authorization',
      value: 'Basic ' + 'REPLACE_BASIC_AUTH',
    })
  } else if (apiKeyAuthDef) {
    headers.push({
      name: apiKeyAuthDef.name,
      value: 'REPLACE_KEY_VALUE',
    })
  } else if (oauthDef) {
    headers.push({
      name: 'Authorization',
      value: 'Bearer ' + 'REPLACE_BEARER_TOKEN',
    })
  }

  return headers
}

/**
 * Produces array of HAR files for given OpenAPI document
 *
 * @param  {object}   openApi          OpenAPI document
 * @param  {Function} callback
 */
const openApiToHarList = function (openApi) {
  try {
    // iterate openApi and create har objects:
    const harList = []
    for (const path in openApi.paths) {
      for (const method in openApi.paths[path]) {
        const url = getBaseUrl(openApi, path, method) + path
        const hars = createHar(openApi, path, method)
        // need to push multiple here
        harList.push({
          method: method.toUpperCase(),
          url: url,
          description:
            openApi.paths[path][method].description ||
            'No description available',
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
 *
 * @param  {object} openApi  OpenAPI document
 * @param  {string} ref      A reference string
 * @return {any}
 */
const resolveRef = function (openApi, ref) {
  const parts = ref.split('/')

  if (parts.length <= 1) return {} // = 3

  const recursive = function (obj, index) {
    if (index + 1 < parts.length) {
      // index = 1
      const newCount = index + 1
      return recursive(obj[parts[index]], newCount)
    }
    return obj[parts[index]]
  }
  return recursive(openApi, 1)
}

export {
  openApiToHarList as getAll,
  createHar as getEndpoint,
  createHarParameterObjects,
}
