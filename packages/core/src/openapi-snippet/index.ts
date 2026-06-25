// @ts-nocheck
/**
 * openapi-snippet
 *
 * Generates code snippets from Open API (previously Swagger) documents.
 *
 * Author: Erik Wittern
 * License: MIT
 */
import { availableTargets, HTTPSnippet } from 'httpsnippet'
import { isSchemaTarget, SCHEMA_TARGETS } from '../schema-codegen/registry.ts'
import { generateTypedSnippet } from '../schema-codegen/snippet.ts'
import * as OpenAPIToHar from './openapi-to-har.ts'

const METHOD_ORDER = ['get', 'post', 'put', 'delete', 'patch']

/**
 * Return snippets for endpoint identified using path and method in the given
 * OpenAPI document.
 */
const getEndpointSnippets = (openApi, path, method, targets, values = {}, options = {}) => {
  // Schema-codegen targets (zod/valibot/pydantic) are not httpsnippet targets;
  // they emit typed request snippets from the operation's response schema.
  const httpTargets = targets.filter((t) => !isSchemaTarget(t))
  const schemaTargets = targets.filter((t) => isSchemaTarget(t))

  const hars = OpenAPIToHar.getEndpoint(openApi, path, method, values, options)

  if (hars.length === 0) throw new Error(`No HAR for ${method.toUpperCase()} ${path}`)

  const snippets = []
  for (const har of hars) {
    const snippet = new HTTPSnippet(har)
    snippets.push(
      ...getSnippetsForTargets(httpTargets, snippet, har.comment ? har.comment : undefined),
    )
  }
  for (const target of schemaTargets) {
    snippets.push({
      id: target,
      title: SCHEMA_TARGETS[target].title,
      content: generateTypedSnippet(openApi, path, method, target),
    })
  }

  // use first element since method, url, and description
  // are the same for all elements
  return {
    method: hars[0].method,
    url: hars[0].url,
    description: hars[0].description,
    resource: getResourceName(hars[0].url),
    snippets,
  }
}

/**
 * Return snippets for all endpoints in the given OpenAPI document.
 */
const getSnippets = (openApi, targets, options = {}) => {
  const endpointHarInfoList = OpenAPIToHar.getAll(openApi, options)
  // This bulk path only handles httpsnippet targets; schema-codegen targets
  // need per-operation context and go through getEndpointSnippets instead.
  const httpTargets = targets.filter((t) => !isSchemaTarget(t))

  const results = []
  for (const harInfo of endpointHarInfoList) {
    // create HTTPSnippet object:
    const snippets = []
    for (const har of harInfo.hars) {
      const snippet = new HTTPSnippet(har)
      snippets.push(...getSnippetsForTargets(httpTargets, snippet, har.comment))
    }

    results.push({
      method: harInfo.method,
      url: harInfo.url,
      description: harInfo.description,
      resource: getResourceName(harInfo.url),
      snippets,
    })
  }

  // sort results:
  results.sort((a, b) => {
    if (a.resource < b.resource) {
      return -1
    }
    if (a.resource > b.resource) {
      return 1
    }
    return getMethodOrder(a.method.toLowerCase(), b.method.toLowerCase())
  })

  return results
}

/**
 * Determine the order of HTTP methods.
 *
 * @return {number} The order instruction for the given HTTP verbs
 */
const getMethodOrder = (a, b) => {
  const ai = METHOD_ORDER.indexOf(a)
  const bi = METHOD_ORDER.indexOf(b)
  if (ai === -1) return 1
  if (bi === -1) return -1
  if (ai < bi) return -1
  if (ai > bi) return 1
  return 0
}

/**
 * Determines the name of the resource exposed by the method.
 * E.g., ../users/{userId} --> users
 */
const getResourceName = (urlStr) => {
  const pathComponents = urlStr.split('/')
  for (let i = pathComponents.length - 1; i >= 0; i--) {
    const cand = pathComponents[i]
    if (cand !== '' && !/^{/.test(cand)) {
      return cand
    }
  }
  return ''
}

/**
 * Format the given target by splitting up language and library and making sure
 * that HTTP Snippet supports them.
 */
const formatTarget = (targetStr) => {
  const [language, libHint] = targetStr.split('_')
  const title = capitalizeFirstLetter(language)
  let library = libHint

  const validTargets = availableTargets()
  let validLanguage = false
  let validLibrary = false
  for (const target of validTargets) {
    if (language === target.key) {
      validLanguage = true
      if (typeof library === 'undefined') {
        library = target.default
        validLibrary = true
      } else {
        for (const client of target.clients) {
          if (library === client.key) {
            validLibrary = true
            break
          }
        }
      }
    }
  }

  if (!validLanguage || !validLibrary) {
    return null
  }

  return {
    title: typeof library !== 'undefined' ? `${title} + ${capitalizeFirstLetter(library)}` : title,
    language,
    library,
  }
}

/**
 * Generate code snippets for each of the supplied targets
 */
const getSnippetsForTargets = (targets, snippet, mimeType) => {
  const snippets = []
  for (const targetStr of targets) {
    const target = formatTarget(targetStr)
    if (!target) throw new Error(`Invalid target: ${targetStr}`)
    snippets.push({
      id: targetStr,
      ...(mimeType !== undefined && { mimeType: mimeType }),
      title: target.title,
      content: snippet.convert(
        target.language,
        typeof target.library !== 'undefined' ? target.library : null,
      ),
    })
  }
  return snippets
}

const capitalizeFirstLetter = (string) => string.charAt(0).toUpperCase() + string.slice(1)

export { getSnippets, getEndpointSnippets }
