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
  if (opts.cache === 'string' && !Cache) { Cache = require('./cache') }
  opts.cache = opts.cache && (
    typeof opts.cache === 'string'
    ? new Cache(opts.cache, opts.cacheOpts)
    : opts.cache
  )
  opts.cacheMode = opts.cache && (opts.cacheMode || 'default')
  if (opts.cacheMode === 'default' && isConditional(opts.headers || {})) {
    // If header list contains `If-Modified-Since`, `If-None-Match`,
    // `If-Unmodified-Since`, `If-Match`, or `If-Range`, fetch will set cache
    // mode to "no-store" if it is "default".
    opts.cacheMode = 'no-store'
  }
  let res
  if (
    (!opts.method || opts.method.toLowerCase() === 'get') &&
    opts.cache &&
    opts.cacheMode !== 'no-store' &&
    opts.cacheMode !== 'reload'
  ) {
    res = opts.cache.match(uri, opts.cacheOpts)
  }
  return fetch.Promise.resolve(res).then(res => {
    if (res && opts.cacheMode === 'default' && !isStale(res)) {
      return res
    } else if (res && (opts.cacheMode === 'default' || opts.cacheMode === 'no-cache')) {
      return condFetch(uri, res, opts)
    } else if (!res && opts.cacheMode === 'only-if-cached') {
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

// https://tools.ietf.org/html/rfc7234#section-4.2.1
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
    return 300
  }
}

function condFetch (uri, cachedRes, opts) {
  const newHeaders = {}
  Object.keys(opts.headers || {}).forEach(k => {
    newHeaders[k] = opts.headers[k]
  })
  if (cachedRes.headers.get('etag')) {
    const condHeader = opts.method && opts.method.toLowerCase() !== 'get'
    ? 'if-match'
    : 'if-none-match'
    newHeaders[condHeader] = cachedRes.headers.get('etag')
  }
  if (cachedRes.headers.get('last-modified')) {
    const condHeader = opts.method && opts.method.toLowerCase() !== 'get'
    ? 'if-unmodified-since'
    : 'if-modified-since'
    newHeaders[condHeader] = cachedRes.headers.get('last-modified')
  }
  opts.headers = newHeaders
  return remoteFetch(uri, opts).then(condRes => {
    if (condRes.status === 304) {
      condRes.body = cachedRes.body
    } else if (condRes.status >= 500) {
      if (condRes.method.toLowerCase() === 'get') {
        return cachedRes
      } else {
        return opts.cache.delete(uri).then(() => cachedRes)
      }
    }
    if (condRes.method.toLowerCase() !== 'get') {
      return opts.cache.delete(uri).then(() => condRes)
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
  return retry((retryHandler, attemptNum) => {
    const req = new fetch.Request(uri, {
      agent,
      body: opts.body,
      compress: opts.compress,
      follow: opts.follow,
      headers,
      method: opts.method,
      redirect: opts.redirect || 'follow',
      size: opts.size,
      timeout: opts.timeout || 0
    })
    return fetch(req).then(res => {
      if (
        req.method.toLowerCase() === 'get' &&
        opts.cache &&
        opts.cacheMode !== 'no-store' &&
        res.status < 300 &&
        res.status >= 200
      ) {
        return opts.cache.put(req, res, opts.cacheOpts)
      } else if (req.method.toLowerCase() !== 'post' && res.status >= 500) {
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
