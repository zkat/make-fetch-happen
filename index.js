'use strict'

let Cache
const fetch = require('node-fetch')
const LRU = require('lru-cache')
const pkg = require('./package.json')
const retry = require('promise-retry')
let ssri
const Stream = require('stream')
const url = require('url')

const RETRY_ERRORS = [
  'ECONNRESET', // remote socket closed on us
  'ECONNREFUSED', // remote host refused to open connection
  'EADDRINUSE', // failed to bind to a local port (proxy?)
  'ETIMEDOUT' // someone in the transaction is WAY TOO SLOW
  // Known codes we do NOT retry on:
  // ENOTFOUND (getaddrinfo failure. Either bad hostname, or offline)
]

const RETRY_TYPES = [
  'request-timeout'
]

// https://fetch.spec.whatwg.org/#http-network-or-cache-fetch
module.exports = cachingFetch
cachingFetch.defaults = function (_uri, _opts) {
  const fetch = this
  if (typeof _uri === 'object') {
    _opts = _uri
    _uri = null
  }
  function defaultedFetch (uri, opts) {
    let finalOpts
    if (opts && _opts) {
      finalOpts = {}
      Object.keys(_opts).forEach(k => { finalOpts[k] = _opts[k] })
      Object.keys(opts).forEach(k => { finalOpts[k] = opts[k] })
    } else if (opts) {
      finalOpts = opts
    } else if (_opts) {
      finalOpts = _opts
    } else {
      finalOpts = {}
    }
    return fetch(uri || _uri, finalOpts)
  }
  defaultedFetch.defaults = fetch.defaults
  return defaultedFetch
}

function cachingFetch (uri, _opts) {
  const opts = {}
  Object.keys(_opts || {}).forEach(k => { opts[k] = _opts[k] })
  opts.method = (opts.method || 'GET').toUpperCase()
  if (typeof opts.cacheManager === 'string' && !Cache) {
    // Default cacache-based cache
    Cache = require('./cache')
  }
  if (opts.integrity && !ssri) {
    ssri = require('ssri')
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
    (opts.method === 'GET' || opts.method === 'HEAD') &&
    opts.cacheManager &&
    opts.cache !== 'no-store' &&
    opts.cache !== 'reload'
  ) {
    const req = new fetch.Request(uri, {
      method: opts.method,
      headers: opts.headers
    })
    return opts.cacheManager.match(req, opts).then(res => {
      if (res) {
        const warningCode = (res.headers.get('Warning') || '').match(/^\d+/)
        if (warningCode && +warningCode >= 100 && +warningCode < 200) {
          // https://tools.ietf.org/html/rfc7234#section-4.3.4
          res.headers.delete('Warning')
        }
      }
      if (res && opts.cache === 'default' && !isStale(res)) {
        return res
      } else if (res && (opts.cache === 'default' || opts.cache === 'no-cache')) {
        return condFetch(uri, res, opts)
      } else if (res && (
        opts.cache === 'force-cache' || opts.cache === 'only-if-cached'
      )) {
        return res
      } else if (!res && opts.cache === 'only-if-cached') {
        const err = new Error(
          `request to ${
            uri
          } failed: cache mode is 'only-if-cached' but no cached response available.`
        )
        err.code = 'ENOTCACHED'
        throw err
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
  const ctrl = res.headers.get('Cache-Control') || ''
  if (ctrl.match(/must-revalidate/i)) {
    return true
  }
  if (ctrl.match(/immutable/i)) {
    return false
  }
  const maxAge = freshnessLifetime(res)
  const currentAge = (new Date() - new Date(res.headers.get('Date') || new Date())) / 1000
  return maxAge <= currentAge
}

// https://tools.ietf.org/html/rfc7234#section-4.2.1
function freshnessLifetime (res) {
  const cacheControl = res.headers.get('Cache-Control') || ''
  const pragma = res.headers.get('Pragma') || ''
  const maxAgeMatch = cacheControl.match(/(?:s-maxage|max-age)\s*=\s*(\d+)/i)
  const noCacheMatch = (
    cacheControl.match(/no-cache/i) ||
    pragma.match(/no-cache/i)
  )
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
  !res.headers.get('Warning') && setWarning(
    res, 113, 'Used heuristics to calculate cache freshness'
  )
  if (lastMod) {
    const age = (date - new Date(lastMod)) / 1000
    return Math.min(age * 0.1, 300)
  } else {
    return 300
  }
}

function condFetch (uri, cachedRes, opts) {
  const ctrl = cachedRes.headers.get('cache-control') || ''
  const newHeaders = {}
  Object.keys(opts.headers || {}).forEach(k => {
    newHeaders[k] = opts.headers[k]
  })
  if (cachedRes.headers.get('etag')) {
    const condHeader = opts.method !== 'GET'
    ? 'if-match'
    : 'if-none-match'
    newHeaders[condHeader] = cachedRes.headers.get('etag')
  }
  if (cachedRes.headers.get('last-modified')) {
    const condHeader = opts.method !== 'GET' && opts.method !== 'HEAD'
    ? 'if-unmodified-since'
    : 'if-modified-since'
    newHeaders[condHeader] = cachedRes.headers.get('last-modified')
  }
  opts.headers = newHeaders
  if (isStale(cachedRes)) {
    setWarning(cachedRes, 110, 'Local cached response stale')
  }
  return remoteFetch(uri, opts).then(condRes => {
    if (condRes.status === 304) {
      condRes.body = cachedRes.body
      condRes.headers.set('Warning', cachedRes.headers.get('Warning'))
    } else if (condRes.status >= 500 && !ctrl.match(/must-revalidate/i)) {
      setWarning(
        cachedRes, 111, `Revalidation failed. Returning stale response`
      )
      return cachedRes
    }
    return condRes
  }).catch(err => {
    if (ctrl.match(/must-revalidate/i)) {
      throw err
    } else {
      setWarning(cachedRes, 111, `${err.code}: ${err.message}`)
      return cachedRes
    }
  })
}

function setWarning (reqOrRes, code, message, host) {
  host = host || 'localhost'
  reqOrRes.headers.set(
    'Warning',
    `${code} ${host} ${
      JSON.stringify(message)
    } ${
      JSON.stringify(new Date().toUTCString)
    }`
  )
}

function remoteFetch (uri, opts) {
  const agent = getAgent(uri, opts)
  const headers = {
    'connection': agent ? 'keep-alive' : 'close',
    'user-agent': `${pkg.name}/${pkg.version} (+https://npm.im/${pkg.name})`
  }
  if (opts.headers) {
    Object.keys(opts.headers).forEach(k => {
      headers[k] = opts.headers[k]
    })
  }
  const reqOpts = {
    agent,
    body: opts.body,
    compress: opts.compress,
    follow: opts.follow,
    headers,
    method: opts.method,
    redirect: opts.redirect,
    size: opts.size,
    timeout: opts.timeout
  }
  return retry((retryHandler, attemptNum) => {
    const req = new fetch.Request(uri, reqOpts)
    return fetch(req).then(res => {
      res.headers.set('x-fetch-attempts', attemptNum)
      if (opts.integrity) {
        const oldBod = res.body
        const newBod = ssri.integrityStream({
          integrity: opts.integrity
        })
        oldBod.pipe(newBod)
        res.body = newBod
        oldBod.once('error', err => {
          newBod.emit('error', err)
        })
        newBod.once('error', err => {
          oldBod.emit('error', err)
        })
      }
      const cacheCtrl = res.headers.get('cache-control') || ''
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        opts.cacheManager &&
        !cacheCtrl.match(/no-store/i) &&
        opts.cache !== 'no-store' &&
        // No other statuses should be stored!
        (res.status === 200 || res.status === 304)
      ) {
        return opts.cacheManager.put(req, res, opts)
      } else if (opts.cacheManager && (
        (req.method !== 'GET' && req.method !== 'HEAD')
      )) {
        return opts.cacheManager.delete(req, opts.cacheOpts).then(() => {
          if (res.status >= 500) {
            if (req.method === 'POST') {
              return res
            } else if (req.body instanceof Stream) {
              return res
            } else {
              return retryHandler(res)
            }
          } else {
            return res
          }
        })
      } else if (
        // Retriable + rate-limiting status codes
        // When hitting an API with rate-limiting features,
        // be sure to set the `retry` settings according to
        // documentation for that.
        res.status === 404 || // Not Found ("subsequent requests permissible")
        res.status === 408 || // Request Timeout
        res.status === 420 || // Enhance Your Calm (usually Twitter rate-limit)
        res.status === 429 || // Too Many Requests ("standard" rate-limiting)
        // Assume server errors are momentary hiccups
        res.status >= 500
      ) {
        if (req.method === 'POST') {
          return res
        } else if (req.body instanceof Stream) {
          return res
        } else {
          return retryHandler(res)
        }
      } else {
        return res
      }
    }).catch(err => {
      const code = err.code === 'EPROMISERETRY'
      ? err.retried.code
      : err.code
      if (
        req.method !== 'POST' && (
          RETRY_ERRORS.indexOf(code) >= 0 ||
          RETRY_TYPES.indexOf(err.type) >= 0
        )
      ) {
        return retryHandler(err)
      } else {
        throw err
      }
    })
  }, opts.retry === false ? { retries: 0 } : opts.retry).catch(err => {
    if (err.status >= 400) {
      return err
    } else {
      throw err
    }
  })
}

let AGENT_CACHE = new LRU({
  max: 50
})
let HttpsAgent
let HttpAgent
function getAgent (uri, opts) {
  const parsedUri = url.parse(uri)
  const isHttps = parsedUri.protocol === 'https:'
  const pxuri = getProxyUri(uri, opts)
  const key = [
    `https:${isHttps}`,
    pxuri
    ? `proxy:${pxuri.protocol}//${pxuri.host}:${pxuri.port}`
    : '>no-proxy<',
    `ca:${(isHttps && opts.ca) || '>no-ca<'}`,
    `cert:${(isHttps && opts.cert) || '>no-cert<'}`,
    `key:${(isHttps && opts.key) || '>no-key<'}`
  ].join(':')
  if (opts.agent != null) {
    // `agent: false` has special behavior!
    return opts.agent
  } else if (AGENT_CACHE.peek(key)) {
    return AGENT_CACHE.get(key)
  } else if (pxuri) {
    const proxy = getProxy(pxuri, opts)
    AGENT_CACHE.set(key, proxy)
    return proxy
  } else {
    if (isHttps && !HttpsAgent) {
      HttpsAgent = require('agentkeepalive').HttpsAgent
    } else if (!isHttps && !HttpAgent) {
      HttpAgent = require('agentkeepalive')
    }
    const agent = isHttps
    ? new HttpsAgent({
      maxSockets: opts.maxSockets || 15,
      ca: opts.ca,
      cert: opts.cert,
      key: opts.key
    })
    : new HttpAgent({
      maxSockets: opts.maxSockets || 15
    })
    AGENT_CACHE.set(key, agent)
    return agent
  }
}

function getProxyUri (uri, opts) {
  const puri = url.parse(uri)
  const proxy = opts.proxy || (
    puri.protocol === 'https:' && process.env.https_proxy
  ) || (
    puri.protocol === 'http:' && (
      process.env.https_proxy || process.env.http_proxy || process.env.proxy
    )
  )
  return !checkNoProxy(uri) && (
    typeof proxy === 'string'
    ? url.parse(proxy)
    : proxy
  )
}

let HttpProxyAgent
let HttpsProxyAgent
let SocksProxyAgent
function getProxy (proxyUrl, opts) {
  let popts = {
    host: proxyUrl.hostname,
    port: proxyUrl.port,
    protocol: proxyUrl.protocol,
    path: proxyUrl.path,
    ca: opts.ca,
    cert: opts.cert,
    key: opts.key,
    maxSockets: opts.maxSockets || 15
  }
  if (proxyUrl.protocol === 'http:') {
    if (!HttpProxyAgent) { HttpProxyAgent = require('http-proxy-agent') }
    return new HttpProxyAgent(popts)
  } else if (proxyUrl.protocol === 'https:') {
    if (!HttpsProxyAgent) { HttpsProxyAgent = require('https-proxy-agent') }
    return new HttpsProxyAgent(popts)
  } else if (proxyUrl.startsWith('socks')) {
    if (!SocksProxyAgent) { SocksProxyAgent = require('socks-proxy-agent') }
    return new SocksProxyAgent(popts)
  }
}

function checkNoProxy (uri) {
  // TODO
  return false
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
