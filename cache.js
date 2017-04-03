'use strict'

const cacache = require('cacache')
const fetch = require('node-fetch')
const fs = require('fs')
const pipe = require('mississippi').pipe
const ssri = require('ssri')
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
    this._path = path
    this._uid = opts && opts.uid
    this._gid = opts && opts.gid
    this.Promise = (opts && opts.Promise) || Promise
  }

  // Returns a Promise that resolves to the response associated with the first
  // matching request in the Cache object.
  match (req, opts) {
    return cacache.get.info(this._path, cacheKey(req)).then(info => {
      if (info && matchDetails(req, {
        url: info.metadata.url,
        reqHeaders: new fetch.Headers(info.metadata.reqHeaders),
        resHeaders: new fetch.Headers(info.metadata.resHeaders),
        cacheIntegrity: info.integrity,
        integrity: opts && opts.integrity
      })) {
        if (req.method === 'HEAD') {
          return new fetch.Response(null, {
            url: req.url,
            headers: info.metadata.resHeaders,
            status: 200
          })
        }
        return new this.Promise((resolve, reject) => {
          fs.stat(info.path, (err, stat) => {
            if (err) {
              return reject(err)
            } else {
              return resolve(stat)
            }
          })
        }).then(stat => {
          const cachePath = this._path
          let disturbed = false
          // avoid opening cache file handles until a user actually tries to
          // read from it.
          const body = through((chunk, enc, cb) => {
            if (disturbed) {
              cb(null, chunk, enc)
            } else {
              disturbed = true
              if (stat.size > MAX_MEM_SIZE) {
                pipe(
                  cacache.get.stream.byDigest(cachePath, info.integrity),
                  body,
                  () => {}
                )
              } else {
                // cacache is much faster at bulk reads
                cacache.get.byDigest(cachePath, info.integrity, {
                  memoize: true
                }).then(data => {
                  body.write(data, () => {
                    body.end()
                  })
                }, err => body.emit('error', err))
              }
              cb() // throw away dummy data
            }
          })
          body.write('dummy')
          return new fetch.Response(body, {
            url: req.url,
            headers: info.metadata.resHeaders,
            status: 200,
            size: stat.size
          })
        }).catch({code: 'ENOENT'}, () => {
          return null
        })
      }
    })
  }

  // Takes both a request and its response and adds it to the given cache.
  put (req, response) {
    const size = response.headers.get('content-length')
    const fitInMemory = !!size && size < MAX_MEM_SIZE
    const opts = {
      metadata: {
        url: req.url,
        reqHeaders: req.headers.raw(),
        resHeaders: response.headers.raw()
      },
      uid: this._uid,
      gid: this._gid,
      size,
      memoize: fitInMemory
    }
    if (req.method === 'HEAD' || response.status === 304) {
      // Update metadata without writing
      return cacache.get.info(this._path, cacheKey(req)).then(info => {
        // Providing these will bypass content write
        opts.integrity = info.integrity
        return new this.Promise((resolve, reject) => {
          pipe(
            cacache.get.stream.byDigest(this._path, info.integrity, opts),
            cacache.put.stream(this._path, cacheKey(req), opts),
            err => err ? reject(err) : resolve(response)
          )
        })
      }).then(() => response)
    }
    let buf = []
    let bufSize = 0
    let cacheTargetStream = false
    const cachePath = this._path
    let cacheStream = to((chunk, enc, cb) => {
      if (!cacheTargetStream) {
        if (fitInMemory) {
          cacheTargetStream =
          to({highWaterMark: MAX_MEM_SIZE}, (chunk, enc, cb) => {
            buf.push(chunk)
            bufSize += chunk.length
            cb()
          }, done => {
            cacache.put(
              cachePath,
              cacheKey(req),
              Buffer.concat(buf, bufSize),
              opts
            ).then(
              () => done(),
              done
            )
          })
        } else {
          cacheTargetStream =
          cacache.put.stream(cachePath, cacheKey(req), opts)
        }
      }
      cacheTargetStream.write(chunk, enc, cb)
    }, done => {
      cacheTargetStream ? cacheTargetStream.end(done) : done()
    })
    const oldBody = response.body
    const newBody = through({highWaterMark: fitInMemory && MAX_MEM_SIZE})
    response.body = newBody
    oldBody.once('error', err => newBody.emit('error', err))
    newBody.once('error', err => oldBody.emit('error', err))
    cacheStream.once('error', err => newBody.emit('error', err))
    pipe(oldBody, to((chunk, enc, cb) => {
      cacheStream.write(chunk, enc, () => {
        newBody.write(chunk, enc, cb)
      })
    }, done => {
      cacheStream.end(() => {
        newBody.end(() => {
          done()
        })
      })
    }), err => err && newBody.emit('error', err))
    return response
  }

  // Finds the Cache entry whose key is the request, and if found, deletes the
  // Cache entry and returns a Promise that resolves to true. If no Cache entry
  // is found, it returns false.
  'delete' (req) {
    return cacache.rm.entry(
      this._path,
      cacheKey(req)
    // TODO - true/false
    ).then(() => false)
  }
}

function matchDetails (req, cached) {
  const reqUrl = url.parse(req.url)
  const cacheUrl = url.parse(cached.url)
  const vary = cached.resHeaders.get('Vary')
  // https://tools.ietf.org/html/rfc7234#section-4.1
  if (vary) {
    if (vary.match(/\*/)) {
      return false
    } else {
      const fieldsMatch = vary.split(/\s*,\s*/).every(field => {
        return cached.reqHeaders.get(field) === req.headers.get(field)
      })
      if (!fieldsMatch) {
        return false
      }
    }
  }
  if (cached.integrity) {
    const cachedSri = ssri.parse(cached.cacheIntegrity)
    const sri = ssri.parse(cached.integrity)
    const algo = sri.pickAlgorithm()
    if (cachedSri[algo] && !sri[algo].some(hash => {
      // cachedSri always has exactly one item per algorithm
      return cachedSri[algo][0].digest === hash.digest
    })) {
      return false
    }
  }
  reqUrl.hash = null
  cacheUrl.hash = null
  return url.format(reqUrl) === url.format(cacheUrl)
}
