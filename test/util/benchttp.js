'use strict'

const BB = require('bluebird')
const Buffer = require('safe-buffer').Buffer

const cacache = require('cacache')
const fetch = require('node-fetch-npm')
const niceFetch = require('../..')
const nock = require('nock')
const path = require('path')
const request = require('request')
const rimraf = require('rimraf')
const zlib = require('zlib')

const CACHE = path.join(__dirname, '../cache/benchmark')
const TIMES = 100
const HOST = 'https://registry.npmjs.org'
const URL = `${HOST}/cacache`
const BODY = {
  name: 'cacache',
  version: '1.2.3'
}
const GZBody = zlib.gzipSync(Buffer.from(JSON.stringify(BODY)))

nock(HOST).get('/cacache').times(Infinity).delay(20).reply(200, GZBody, {
  'content-encoding': 'gzip',
  'cache-control': 'immutable'
})

function benchRequest () {
  console.time('request')
  return _reqLoop(TIMES).then(() => {
    console.timeEnd('request')
  })
}

function _reqLoop (n) {
  return BB.fromNode(cb => {
    request({
      uri: URL,
      headers: {
        gzip: true
      }
    }, cb)
  }).then(() => {
    if (n > 0) {
      return _reqLoop(n - 1)
    }
  })
}

function benchFetch () {
  console.time('fetch')
  return _fetchLoop(TIMES).then(() => {
    console.timeEnd('fetch')
  })
}

function _fetchLoop (n) {
  return fetch(URL).then(res => res.json()).then(() => {
    if (n > 0) {
      return _fetchLoop(n - 1)
    }
  })
}

function benchNiceFetch () {
  console.time('make-fetch-happen')
  return _niceFetchLoop(TIMES).then(() => {
    console.timeEnd('make-fetch-happen')
  })
}

function _niceFetchLoop (n) {
  return niceFetch(URL).then(res => res.json()).then(() => {
    if (n > 0) {
      return _fetchLoop(n - 1)
    }
  })
}

function benchCachedFetch () {
  console.time('cached-make-fetch-happen')
  return _cachedFetchLoop(TIMES).then(() => {
    console.timeEnd('cached-make-fetch-happen')
  })
}

function _cachedFetchLoop (n) {
  cacache.clearMemoized()
  return niceFetch(URL, {
    cacheManager: CACHE
  }).then(res => res.json()).then(res => {
    if (n > 0) {
      return _cachedFetchLoop(n - 1)
    }
  })
}

function benchMemoFetch () {
  console.time('memoized-make-fetch-happen')
  return _memoFetchLoop(TIMES).then(() => {
    console.timeEnd('memoized-make-fetch-happen')
  })
}

function _memoFetchLoop (n) {
  return niceFetch(URL, {
    cacheManager: CACHE
  }).then(res => res.json()).then(res => {
    if (n > 0) {
      return _memoFetchLoop(n - 1)
    }
  })
}

BB.using(
  benchRequest().then(benchFetch).then(benchNiceFetch).then(benchCachedFetch).then(benchMemoFetch).disposer(() => rimraf.sync(CACHE)),
  () => {
    console.log('done!')
  }
)
