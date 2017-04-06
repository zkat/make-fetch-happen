'use strict'

let Cache
const fetch = require('node-fetch')
let ProxyAgent
const pkg = require('./package.json')
const retry = require('promise-retry')
let ssri
const Stream = require('stream')

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
      setWarning(cachedRes, 111, `Unexpected error: ${err.message}`)
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
      } else if (res.status === 408 || res.status >= 500) {
        // 408 === timeout
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
      if (req.method !== 'POST') {
        return retryHandler(err)
      } else {
        throw err
      }
    })
  }, opts.retry === false ? { retries: 0 } : opts.retry).catch(err => {
    if (err.status >= 500 || err.status === 408) {
      return err
    } else {
      throw err
    }
  })
}

let httpsAgent
let httpAgent
function getAgent (uri, opts) {
  if (opts.agent != null) {
    // `agent: false` has special behavior!
    return opts.agent
  } else if (opts.proxy) {
    if (!ProxyAgent) {
      ProxyAgent = require('proxy-agent')
    }
    return new ProxyAgent(opts.proxy)
  } else if (uri.trim().startsWith('https:')) {
    if (!httpsAgent) {
      const Agent = require('agentkeepalive').HttpsAgent
      httpsAgent = new Agent({maxSockets: 15})
    }
    return httpsAgent
  } else {
    if (!httpAgent) {
      const Agent = require('agentkeepalive')
      httpAgent = new Agent({maxSockets: 15})
    }
    return httpAgent
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
