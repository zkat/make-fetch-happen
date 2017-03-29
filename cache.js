'use strict'

const cacache = require('cacache')
const fetch = require('node-fetch')
const fs = require('fs')
const pipe = require('mississippi').pipe
const through = require('mississippi').through
const to = require('mississippi').to

const MAX_MEM_SIZE = 5 * 1024 * 1024 // 5MB

function cacheKey (req) {
  return `make-fetch-happen:request-cache:${
    (req.method || 'GET').toUpperCase()
  }:${
    req.headers && req.headers.get('accept-encoding') || '*'
  }:${
    req.uri
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
      if (info) {
        // TODO - if it's small enough, slurp into memory
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
      headers: response.headers.raw()
    }
    if (false && size && size < MAX_MEM_SIZE) {
      return response.buffer().then(data => {
        return cacache.put(
          this._cachePath,
          cacheKey(req),
          data,
          this._cacheOpts
        )
      }).then(() => response)
    } else {
      const stream = cacache.put.stream(
        this._cachePath,
        cacheKey(req.url),
        this._cacheOpts
      )
      const oldBody = response.body
      const newBody = through()
      response.body = newBody
      oldBody.once('error', err => newBody.emit('error', err))
      newBody.once('error', err => oldBody.emit('error', err))
      stream.once('error', err => newBody.emit('error', err))
      pipe(oldBody, to((chunk, enc, cb) => {
        stream.write(chunk, enc, () => {
          newBody.write(chunk, enc, cb)
        })
      }, done => {
        stream.end(() => newBody.end(done))
      }))
      return response
    }
  }

  // Finds the Cache entry whose key is the request, and if found, deletes the
  // Cache entry and returns a Promise that resolves to true. If no Cache entry
  // is found, it returns false.
  ['delete'] (request, options) {
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
