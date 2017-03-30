'use strict'

const cacache = require('cacache')
const fetch = require('node-fetch')
const fs = require('fs')
const pipe = require('mississippi').pipe
const through = require('mississippi').through
const to = require('mississippi').to
const url = require('url')

const MAX_MEM_SIZE = 5 * 1024 * 1024 // 5MB

function cacheKey (req) {
  const parsed = url.parse(req.url)
  return `make-fetch-happen:request-cache:${
    url.format({
      protocol: parsed.protocol,
      slashes: parsed.slashes,
      host: parsed.host,
      hostname: parsed.hostname,
      pathname: parsed.pathname
    })
  }`
}

// This is a cacache-based implementation of the Cache standard,
// using node-fetch.
// docs: https://developer.mozilla.org/en-US/docs/Web/API/Cache
//
module.exports = class Cache {
  constructor (path, opts) {
    this._cachePath = path
    this._cacheOpts = opts
    this.Promise = opts.Promise || Promise
  }

  // Returns a Promise that resolves to the response associated with the first
  // matching request in the Cache object.
  match (request, opts) {
    // TODO - opts.ignoreSearch, opts.ignoreMethod, opts.ignoreVary
    request = new fetch.Request(request)
    return cacache.get.info(
      this._cachePath,
      cacheKey(request),
      this._cacheOpts
    ).then(info => {
      if (info && matchDetails(request, info.metadata, opts)) {
        return new this.Promise((resolve, reject) => {
          fs.stat(info.path, (err, stat) => {
            if (err) {
              return reject(err)
            } else {
              return resolve(stat)
            }
          })
        }).then(stat => {
          // meh
          this._cacheOpts.hashAlgorithm = info.hashAlgorithm

          let body
          if (stat.size > MAX_MEM_SIZE) {
            body = cacache.get.stream.byDigest(
              this._cachePath,
              info.digest,
              this._cacheOpts
            )
          } else {
            // cacache is much faster at bulk reads
            body = through()
            cacache.get.byDigest(
              this._cachePath,
              info.digest,
              this._cacheOpts
            ).then(data => {
              body.write(data, () => {
                body.end()
              })
            }, err => body.emit('error', err))
          }
          return new fetch.Response(body, {
            url: request.url,
            headers: info.metadata.headers,
            status: 200,
            size: stat.size
          })
        }).catch({code: 'ENOENT'}, () => {
          return null
        })
      }
    })
  }

  // Returns a Promise that resolves to an array of all matching requests in
  // the Cache object.
  matchAll (request, options) {
    return this.Promise.reject(new Error('Cache.matchAll not implemented'))
  }

  // Takes a URL, retrieves it and adds the resulting response object to the
  // given cache. This is fuctionally equivalent to calling fetch(), then using
  // Cache.put() to add the results to the cache.
  add (request) {
    return this.Promise.reject(new Error('Cache.add not implemented'))
  }

  // Takes an array of URLs, retrieves them, and adds the resulting response
  // objects to the given cache.
  addAll (requests) {
    return this.Promise.reject(new Error('Cache.addAll not implemented'))
  }

  // Takes both a request and its response and adds it to the given cache.
  put (request, response) {
    const req = new fetch.Request(request)
    const size = response.headers.get('content-length')
    this._cacheOpts.metadata = {
      url: request.url,
      headers: response.headers.raw()
    }
    let buf = []
    let bufSize = 0
    let cacheStream = (size && size < MAX_MEM_SIZE)
    ? to({highWaterMark: MAX_MEM_SIZE}, (chunk, enc, cb) => {
      buf.push(chunk)
      bufSize += chunk.length
      cb()
    }, done => {
      cacache.put(
        this._cachePath,
        cacheKey(req),
        Buffer.concat(buf, bufSize),
        this._cacheOpts
      ).then(done, done)
    })
    : cacache.put.stream(
      this._cachePath,
      cacheKey(req),
      this._cacheOpts
    )
    const oldBody = response.body
    const newBody = through()
    response.body = newBody
    oldBody.once('error', err => newBody.emit('error', err))
    newBody.once('error', err => oldBody.emit('error', err))
    cacheStream.once('error', err => newBody.emit('error', err))
    pipe(oldBody, to((chunk, enc, cb) => {
      cacheStream.write(chunk, enc, () => {
        newBody.write(chunk, enc, cb)
      })
    }, done => {
      cacheStream.end(() => newBody.end(done))
    }), err => newBody.emit('error', err))
    return response
  }

  // Finds the Cache entry whose key is the request, and if found, deletes the
  // Cache entry and returns a Promise that resolves to true. If no Cache entry
  // is found, it returns false.
  'delete' (request, options) {
    const req = new fetch.Request(request)
    return cacache.rm.entry(
      this._cachePath,
      cacheKey(req.url),
      this._cacheOpts
    // TODO - true/false
    ).then(() => false)
  }

  keys (request, options) {
    return cacache.ls(this._cachePath).then(entries => Object.keys(entries))
  }
}

function matchDetails (req, cached, opts) {
  const reqUrl = url.parse(req.url)
  const cacheUrl = url.parse(cached.url)
  if (!opts.ignoreSearch && (cacheUrl.search !== reqUrl.search)) {
    return false
  }
  if (!opts.ignoreMethod && req.method && req.method !== 'GET') {
    return false
  }
  // TODO - opts.ignoreVary?
  reqUrl.hash = null
  cacheUrl.hash = null
  return url.format(reqUrl) === url.format(cacheUrl)
}
