'use strict'

let Cache
const fetch = require('node-fetch')
const http = require('http')
const https = require('https')
let ProxyAgent
const pkg = require('./package.json')
const url = require('url')

// The "cache mode" options are really confusing, and this module does
// its best to recreate them:
// https://fetch.spec.whatwg.org/#http-network-or-cache-fetch
module.exports = cachingFetch
function cachingFetch (uri, opts) {
  opts = opts || {}
  opts.cache = opts.cache || 'default'
  if (opts.cache === 'default' && isConditional(opts.headers || {})) {
    // If header list contains `If-Modified-Since`, `If-None-Match`,
    // `If-Unmodified-Since`, `If-Match`, or `If-Range`, fetch will set cache
    // mode to "no-store" if it is "default".
    opts.cache = 'no-store'
  }
  let res
  if (
    opts.cachePath && !(
      opts.cache === 'no-store' ||
      opts.cache === 'reload'
    )
  ) {
    if (!Cache) { Cache = require('./cache') }
    res = new Cache(opts.cachePath, opts).match(uri)
  }
  return fetch.Promise.resolve(res).then(res => {
    if (res && opts.cache === 'default' && !isStale(res)) {
      return res
    } else if (res && (opts.cache === 'default' || opts.cache === 'no-cache')) {
      return condFetch(uri, res, opts)
    } else if (!res && opts.cache === 'only-if-cached') {
      throw new Error(`request to ${uri} failed: cache mode is 'only-if-cached' but no cached response available.`)
    } else {
      // Missing cache entry, stale default, reload, no-store
      return remoteFetch(uri, opts)
    }
  })
}

// https://tools.ietf.org/html/rfc7234#section-4.2
function isStale (res) {
  if (!res) { return null }
  const maxAge = freshnessLifetime(res)
  const currentAge = (new Date() - new Date(res.headers.get('Date') || new Date())) / 1000
  return maxAge <= currentAge
}

function freshnessLifetime (res) {
  const cacheControl = res.headers.get('Cache-Control') || ''
  const maxAgeMatch = cacheControl.match(/(?:s-maxage|max-age):\s*(\d+)/)
  if (maxAgeMatch) {
    return +maxAgeMatch[1]
  } else if (res.headers.get('Expires')) {
    const expireDate = new Date(res.headers.get('Expires'))
    const resDate = new Date(res.headers.get('Date') || new Date())
    return (expireDate - resDate) / 1000
  } else {
    return heuristicFreshness(res)
  }
}

// https://tools.ietf.org/html/rfc7234#section-4.2.2
function heuristicFreshness (res) {
  const lastMod = res.headers.get('Last-Modified')
  const date = new Date(res.headers.get('Date') || new Date())
  !res.headers.get('Warning') && res.headers.set('Warning', 113)
  if (lastMod) {
    const age = (date - new Date(lastMod)) / 1000
    return Math.min(age * 0.1, 300)
  } else {
    return 300 * 1000
  }
}

function condFetch (uri, res, opts) {
  const newHeaders = {}
  Object.keys(opts.headers || {}).forEach(k => {
    newHeaders[k] = opts.headers[k]
  })
  if (res.headers.get('etag')) {
    const condHeader = opts.method && opts.method.toLowerCase() !== 'get'
    ? 'if-match'
    : 'if-none-match'
    newHeaders[condHeader] = res.headers.get('etag')
  }
  if (res.headers.get('last-modified')) {
    const condHeader = opts.method && opts.method.toLowerCase() !== 'get'
    ? 'if-unmodified-since'
    : 'if-modified-since'
    newHeaders[condHeader] = res.headers.get('last-modified')
  }
  opts.headers = newHeaders
  return remoteFetch(uri, opts).then(condRes => {
    if (condRes.status === 304) {
      condRes.body = res.body
    } else {
    }
    return condRes
  })
}

function remoteFetch (uri, opts) {
  const headers = {
    'connection': 'keep-alive',
    'user-agent': opts.userAgent || `${pkg.name}/${pkg.version}`
  }
  if (opts.headers) {
    Object.keys(opts.headers).forEach(k => {
      headers[k] = opts.headers[k]
    })
  }
  const agentOpts = url.parse(opts.proxy || uri)
  agentOpts.ca = opts.ca
  agentOpts.cert = opts.cert
  agentOpts.ciphers = opts.ciphers
  if (opts.proxy && !ProxyAgent) {
    ProxyAgent = require('proxy-agent')
  }
  const agent = opts.agent || (opts.proxy
  ? new ProxyAgent(agentOpts)
  : (
    url.parse(uri).protocol === 'https:'
    ? https.globalAgent
    : http.globalAgent
  ))
  const req = new fetch.Request(uri, {
    agent,
    compress: opts.compress == null || opts.compress,
    headers,
    redirect: opts.redirect || 'follow'
  })
  return fetch(req).then(res => {
    if (!opts.cachePath || opts.cache === 'no-store' || res.status > 299) {
      return res
    } else {
      return new Cache(opts.cachePath, opts).put(req, res)
    }
  })
}

function isConditional (headers) {
  return Object.keys(headers).some(h => {
    h = h.toLowerCase()
    return (
      h === 'if-modified-since' ||
      h === 'if-none-match' ||
      h === 'if-unmodified-since' ||
      h === 'if-match' ||
      h === 'if-range'
    )
  })
}
