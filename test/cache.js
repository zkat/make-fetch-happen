'use strict'

const Buffer = require('safe-buffer').Buffer

const test = require('tap').test
const tnock = require('./util/tnock')

const fetch = require('..')

const CACHE = require('./util/test-dir')(__filename)
const CONTENT = Buffer.from('hello, world!')
const HOST = 'https://local.registry.npm'

test('accepts a local path for caches', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT)
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    }).then(res => {
      t.equal(res.status, 200, 'non-stale cached res has 200 status')
      return res.buffer()
    }).then(body => {
      t.deepEqual(body, CONTENT, 'got cached content')
    })
  })
})

test('sends both If-None-Match and If-Modified-Since headers')
test('status code is 304 on revalidated cache hit')
test('status code is 200 on cache miss + request')
test('cached request updated on 304 (so no longer stale)')
test('Warning header removed on cache hit')
test('supports matching using Vary header')
test('invalidates cache on put/post/delete')
test('supports range caching (partial requests)')
test('supports request streaming')
test('supports opts.timeout')
test('request failures do not update cache')
test('only 200-level responses cached')
test('falls back to stale cache on request failure')
test('full Cache-Control response support')
test('heuristic freshness lifetime')
test('Support Cache object injection')
test('mode: default')
test('mode: no-store')
test('mode: reload')
test('mode: no-cache')
test('mode: force-cache')
test('mode: only-if-cached')
