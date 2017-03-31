'use strict'

let Cache
const fetch = require('node-fetch')
const http = require('http')
const https = require('https')
let ProxyAgent
const pkg = require('./package.json')
const retry = require('promise-retry')
const url = require('url')

// The "cache mode" options are really confusing, and this module does
// its best to recreate them:
// https://fetch.spec.whatwg.org/#http-network-or-cache-fetch
module.exports = cachingFetch
function cachingFetch (uri, _opts) {
  const opts = {}
  Object.keys(_opts || {}).forEach(k => { opts[k] = _opts[k] })
  opts.method = opts.method && opts.method.toUpperCase()
  if (typeof opts.cacheManager === 'string' && !Cache) {
    // Default cacache-based cache
    Cache = require('./cache')
  }
  opts.cacheManager = opts.cacheManager && (
    typeof opts.cacheManager === 'string'
    ? new Cache(opts.cacheManager, opts.cacheOpts)
    : opts.cacheManager
  )
  opts.cache = opts.cacheManager && (opts.cache || 'default')
  if (
    opts.cacheManager &&
    opts.cache === 'default' &&
    isConditional(opts.headers || {})
  ) {
    // If header list contains `If-Modified-Since`, `If-None-Match`,
    // `If-Unmodified-Since`, `If-Match`, or `If-Range`, fetch will set cache
    // mode to "no-store" if it is "default".
    opts.cache = 'no-store'
  }
  if (
    (!opts.method || opts.method === 'GET') &&
    opts.cacheManager &&
    opts.cache !== 'no-store' &&
    opts.cache !== 'reload'
  ) {
    return opts.cacheManager.match(uri, opts.cacheOpts).then(res => {
      if (res && opts.cache === 'default' && !isStale(res)) {
        return res
      } else if (res && (opts.cache === 'default' || opts.cache === 'no-cache')) {
        return condFetch(uri, res, opts)
      } else if (!res && opts.cache === 'only-if-cached') {
        throw new Error(`request to ${uri} failed: cache mode is 'only-if-cached' but no cached response available.`)
      } else {
        // Missing cache entry, or mode is default (if stale), reload, no-store
        return remoteFetch(uri, opts)
      }
    })
  } else {
    return remoteFetch(uri, opts)
  }
}

// https://tools.ietf.org/html/rfc7234#section-4.2
function isStale (res) {
  if (!res) { return null }
  const maxAge = freshnessLifetime(res)
  const currentAge = (new Date() - new Date(res.headers.get('Date') || new Date())) / 1000
  return maxAge <= currentAge
}

// https://tools.ietf.org/html/rfc7234#section-4.2.1
function freshnessLifetime (res) {
  const cacheControl = res.headers.get('Cache-Control') || ''
  const maxAgeMatch = cacheControl.match(/(s-maxage|max-age)\s*=\s*(\d+)/i)
  const noCacheMatch = cacheControl.match(/no-cache/i)
  if (noCacheMatch) {
    // no-cache requires revalidation on every request
    return 0
  } else if (maxAgeMatch) {
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
    return 300
  }
}

function condFetch (uri, cachedRes, opts) {
  const newHeaders = {}
  Object.keys(opts.headers || {}).forEach(k => {
    newHeaders[k] = opts.headers[k]
  })
  if (cachedRes.headers.get('etag')) {
    const condHeader = opts.method && opts.method !== 'GET'
    ? 'if-match'
    : 'if-none-match'
    newHeaders[condHeader] = cachedRes.headers.get('etag')
  }
  if (cachedRes.headers.get('last-modified')) {
    const condHeader = opts.method && opts.method !== 'GET'
    ? 'if-unmodified-since'
    : 'if-modified-since'
    newHeaders[condHeader] = cachedRes.headers.get('last-modified')
  }
  opts.headers = newHeaders
  return remoteFetch(uri, opts).then(condRes => {
    const ctrl = cachedRes.headers.get('cache-control') || ''
    if (condRes.status === 304) {
      // TODO - freshen up the cached entry
      condRes.body = cachedRes.body
    } else if (condRes.status >= 500 && !ctrl.match(/must-revalidate/i)) {
      if (condRes.method === 'GET') {
        return cachedRes
      } else {
        return opts.cacheManager.delete(uri).then(() => cachedRes)
      }
    }
    if (condRes.method !== 'GET') {
      return opts.cacheManager.delete(uri).then(() => condRes)
    } else {
      return condRes
    }
  }).catch(() => {
    return cachedRes
  })
}

function remoteFetch (uri, opts) {
  const agent = getAgent(uri, opts)
  const headers = {
    'connection': agent != null ? 'keep-alive' : 'close',
    'user-agent': `${pkg.name}/${pkg.version} (+https://npm.im/${pkg.name})`
  }
  if (opts.headers) {
    Object.keys(opts.headers).forEach(k => {
      headers[k] = opts.headers[k]
    })
  }
  const reqOpts = Object.create(opts)
  reqOpts.headers = headers
  reqOpts.agent = agent
  return retry((retryHandler, attemptNum) => {
    const req = new fetch.Request(uri, reqOpts)
    return fetch(req).then(res => {
      const cacheCtrl = res.headers.get('cache-control') || ''
      if (
        req.method === 'GET' &&
        opts.cacheManager &&
        !cacheCtrl.match(/no-store/i) &&
        opts.cache !== 'no-store' &&
        // No other statuses should be stored!
        res.status === 200
      ) {
        return opts.cacheManager.put(req, res, opts.cacheOpts)
      } else if (req.method !== 'POST' && res.status >= 500) {
        return retryHandler(res)
      } else {
        return res
      }
    }).catch(err => {
      if (req.method !== 'POST') {
        return retryHandler(err)
      } else {
        throw err
      }
    })
  }, opts.retry)
}

function getAgent (uri, opts) {
  if (opts.agent != null) {
    // `agent: false` has special behavior!
    return opts.agent
  } else if (opts.proxy) {
    const agentOpts = url.parse(opts.proxy || uri)
    if (opts.proxyOpts) {
      Object.keys(opts.proxyOpts).forEach(k => {
        agentOpts[k] = opts.proxyOpts[k]
      })
    }
    if (!ProxyAgent) {
      ProxyAgent = require('proxy-agent')
    }
    return new ProxyAgent(agentOpts)
  } else if (url.parse(uri).protocol === 'https:') {
    return https.globalAgent
  } else if (url.parse(uri).protocol === 'http:') {
    return http.globalAgent
  } else {
    return null
  }
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
