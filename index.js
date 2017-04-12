'use strict'

let Cache
const CachePolicy = require('http-cache-semantics')
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
  if (opts.retry && typeof opts.retry === 'number') {
    opts.retry = {retries: opts.retry}
  } else if (opts.retry === false) {
    opts.retry = {retries: 0}
  }
  opts.cacheManager = opts.cacheManager && (
    typeof opts.cacheManager === 'string'
    ? new Cache(opts.cacheManager)
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
      if (res && opts.cache === 'default' && !isStale(req, res)) {
        return res
      } else if (res && (opts.cache === 'default' || opts.cache === 'no-cache')) {
        return condFetch(req, res, opts)
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
        return remoteFetch(req.url, opts)
      }
    })
  } else {
    return remoteFetch(uri, opts)
  }
}

function adaptHeaders (headers) {
  const newHs = {}
  for (let k of headers.keys()) {
    newHs[k] = headers.get(k)
  }
  return newHs
}

function makePolicy (req, res) {
  const _req = {
    url: req.url,
    method: req.method,
    headers: adaptHeaders(req.headers)
  }
  const _res = {
    status: res.status,
    headers: adaptHeaders(res.headers)
  }
  return new CachePolicy(_req, _res, {
    shared: false
  })
}

// https://tools.ietf.org/html/rfc7234#section-4.2
function isStale (req, res) {
  if (!res) { return null }
  const _req = {
    url: req.url,
    method: req.method,
    headers: adaptHeaders(req.headers)
  }
  const bool = !makePolicy(req, res).satisfiesWithoutRevalidation(_req)
  return bool
}

function mustRevalidate (res) {
  return (res.headers.get('cache-control') || '').match(/must-revalidate/i)
}

function condFetch (req, cachedRes, opts) {
  let newHeaders = {}
  Object.keys(opts.headers || {}).forEach(k => {
    newHeaders[k] = opts.headers[k]
  })
  const policy = makePolicy(req, cachedRes)
  const _req = {
    url: req.url,
    method: req.method,
    headers: newHeaders
  }
  opts.headers = policy.revalidationHeaders(_req)
  return remoteFetch(req.url, opts).then(condRes => {
    const revaled = policy.revalidatedPolicy(_req, {
      status: condRes.status,
      headers: adaptHeaders(condRes.headers)
    })
    if (condRes.status === 304) {
      condRes.body = cachedRes.body
      return opts.cacheManager.put(req, condRes, opts).then(newRes => {
        newRes.headers = new fetch.Headers(revaled.policy.responseHeaders())
        if (revaled.modified) {
          setWarning(newRes, 110, 'Revalidation failed even with 304 response. Using stale body with new headers.')
        } else {
          setWarning(newRes, 110, 'Local cached response stale')
        }
        return newRes
      })
    } else if (
      condRes.status >= 500 &&
      !mustRevalidate(cachedRes)
    ) {
      setWarning(
        cachedRes, 111, `Revalidation failed with status ${condRes.status}. Returning stale response`
      )
      return cachedRes
    } else {
      return condRes
    }
  }).then(res => {
    return res
  }).catch(err => {
    if (mustRevalidate(cachedRes)) {
      throw err
    } else {
      setWarning(cachedRes, 111, `${err.code}: ${err.message}`)
      return cachedRes
    }
  })
}

function setWarning (reqOrRes, code, message, host, append) {
  host = host || 'localhost'
  reqOrRes.headers[append ? 'append' : 'set'](
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
  let headers = {
    'connection': agent ? 'keep-alive' : 'close',
    'user-agent': `${pkg.name}/${pkg.version} (+https://npm.im/${pkg.name})`
  }
  if (opts.headers) {
    Object.keys(opts.headers).forEach(k => {
      headers[k] = opts.headers[k]
    })
  }
  headers = new fetch.Headers(headers)
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
      if (
        opts.cacheManager &&
        opts.cache !== 'no-store' &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        makePolicy(req, res).storable() &&
        // No other statuses should be stored!
        res.status === 200
      ) {
        return opts.cacheManager.put(req, res, opts)
      } else if (opts.cacheManager && (
        (req.method !== 'GET' && req.method !== 'HEAD')
      )) {
        return opts.cacheManager.delete(req).then(() => {
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
  }, opts.retry).catch(err => {
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
  const parsedUri = url.parse(typeof uri === 'string' ? uri : uri.url)
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
