'use strict'

const BB = require('bluebird')
const Buffer = require('safe-buffer').Buffer

const finished = BB.promisify(require('mississippi').finished)
const ssri = require('ssri')
const test = require('tap').test
const tnock = require('./util/tnock')

const fetch = require('..')

const CACHE = require('./util/test-dir')(__filename)
const CONTENT = Buffer.from('hello, world!')
const INTEGRITY = ssri.fromData(CONTENT).toString()
const HOST = 'https://local.registry.npm'
const HEADERS = {
  'cache-control': 'max-age=300'
}

test('accepts a local path for caches', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT, HEADERS)
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    t.notOk(
      res.headers.get('x-local-cache'),
      'no cache headers if response is from network'
    )
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'non-stale cached res has 200 status')
    const hs = res.headers
    t.equal(
      decodeURIComponent(hs.get('x-local-cache')),
      CACHE,
      'path added for cached requests'
    )
    t.match(
      decodeURIComponent(hs.get('x-local-cache-key')),
      new RegExp(`${HOST}/test`),
      'cache key contains URI'
    )
    t.equal(
      decodeURIComponent(hs.get('x-local-cache-hash')),
      INTEGRITY,
      'content hash in header'
    )
    t.ok(hs.get('x-local-cache-time'), 'content write time in header')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('supports defaulted fetch cache', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT, HEADERS)
  const defaultFetch = fetch.defaults({
    cacheManager: CACHE
  })
  return defaultFetch(`${HOST}/test`, {
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return defaultFetch(`${HOST}/test`, {
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'non-stale cached res has 200 status')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('nothing cached if body stream never used', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, HEADERS)
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    srv.get('/test').reply(200, 'newcontent', HEADERS)
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'non-stale cached res has 200 status')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, Buffer.from('newcontent'), 'got second req content')
  })
})

test('small responses cached', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT, {
    'Content-Length': CONTENT.length,
    'cache-control': HEADERS['cache-control']
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'non-stale cached res has 200 status')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('supports request streaming', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT, HEADERS)
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    let buf = []
    let bufLen = 0
    res.body.on('data', d => { buf.push(d); bufLen += d.length })
    return finished(res.body).then(() => {
      t.deepEqual(
        Buffer.concat(buf, bufLen),
        CONTENT,
        'initial request streamed correct content'
      )
    })
  }).then(() => {
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    let buf = []
    let bufLen = 0
    res.body.on('data', d => { buf.push(d); bufLen += d.length })
    return finished(res.body).then(() => {
      t.deepEqual(
        Buffer.concat(buf, bufLen),
        CONTENT,
        'cached request streamed correct content'
      )
    })
  })
})

test('only `200 OK` responses cached', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(201, CONTENT, {
    'Foo': 'first',
    'cache-control': HEADERS['cache-control']
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(200, CONTENT, {
      'Foo': 'second',
      'cache-control': HEADERS['cache-control']
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.headers.get('foo'), 'second', 'got second request')
    t.equal(res.status, 200, 'got second request status')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got request content')
  })
})

test('status code is 304 on revalidated cache hit', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'max-age = 0',
    'ETag': 'thisisanetag',
    'Date': new Date(new Date() - 100000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(304, '', {
      'etag': 'W/thisisanetag'
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 304, 'stale cached req returns 304')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('status code is 200 on stale cache + cond request w/ new data', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'max-age = 0',
    'ETag': 'thisisanetag',
    'Date': new Date(new Date() - 100000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(200, 'meh', {
      'Cache-Control': 'max-age=300',
      'ETag': 'thisisanetag',
      'Date': new Date().toUTCString()
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'refreshed cache req returns 200')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, Buffer.from('meh'), 'got new content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'non-stale cached res has 200 status')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, Buffer.from('meh'), 'got cached content')
  })
})

test('forces revalidation if cached response is `must-revalidate`', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'must-revalidate',
    'ETag': 'thisisanetag',
    'Date': new Date().toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(304, function () {
      t.equal(this.req.headers['if-none-match'][0], 'thisisanetag', 'got etag')
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 304, 'revalidated cached req returns 304')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('falls back to stale cache on request failure (adds Warning, too)', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'max-age=0',
    'ETag': 'thisisanetag',
    'Date': new Date().toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(500, function () {
      t.equal(this.req.headers['if-none-match'][0], 'thisisanetag', 'got etag')
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    t.equal(res.status, 200, 'fell back to cached version on error')
    t.match(res.headers.get('Warning'), /111 local\.registry\.npm/, 'added warning')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'cached content returned')
  })
})

test('does not return stale cache on failure if `must-revalidate`', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'must-revalidate',
    'ETag': 'thisisanetag',
    'Date': new Date().toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(500, function () {
      t.equal(this.req.headers['if-none-match'][0], 'thisisanetag', 'got etag')
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    t.equal(res.status, 500, '500-range error returned as-is')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(() => {
    throw new Error('unexpected fetch success')
  }).catch(err => {
    t.equal(err.type, 'system', 'programmatic error returned as-is')
  })
})

test('reqs never stale if Cache-control: immutable', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Expires': new Date(new Date() - 10000000).toUTCString(),
    'Last-Modified': new Date(new Date() - 10000000).toUTCString(),
    'Date': new Date().toUTCString(),
    'Cache-Control': 'immutable'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'used entry from cache even though expired')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('treats reqs as stale on Cache-Control: no-cache in a response', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Expires': new Date(new Date() + 10000000).toUTCString(),
    'Date': new Date().toUTCString(),
    'ETag': 'deadbeef',
    'Cache-Control': 'no-cache',
    'Last-Modified': new Date(new Date() - 10000000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(304, function () {
      t.equal(this.req.headers['if-none-match'][0], 'deadbeef', 'got etag')
      t.ok(this.req.headers['if-modified-since'][0], 'got if-modified-since')
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 304, 'revalidated cached req returns 304')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('treats request as stale on Pragma: no-cache in a response', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Expires': new Date(new Date() + 10000000).toUTCString(),
    'Date': new Date().toUTCString(),
    'ETag': 'deadbeef',
    'Pragma': 'no-cache',
    'Last-Modified': new Date(new Date() - 10000000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(304, function () {
      t.equal(this.req.headers['if-none-match'][0], 'deadbeef', 'got etag')
      t.ok(this.req.headers['if-modified-since'][0], 'got if-modified-since')
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 304, 'revalidated cached req returns 304')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('uses Expires header if no Pragma or Cache-Control', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Expires': new Date(new Date() - 1000).toUTCString(),
    'Date': new Date().toUTCString(),
    'ETag': 'deadbeef',
    'Last-Modified': new Date(new Date() - 10000000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(304, function () {
      t.equal(this.req.headers['if-none-match'][0], 'deadbeef', 'got etag')
      t.ok(this.req.headers['if-modified-since'][0], 'got if-modified-since')
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 304, 'revalidated cached req returns 304')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('heuristic freshness lifetime', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Date': new Date(new Date() - 700000).toUTCString(),
    'Foo': 'some-value',
    'Cache-Control': 'must-revalidate'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    t.equal(res.headers.get('Foo'), 'some-value', 'got original Foo header')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.head('/test').reply(304, '', {
      'Date': new Date().toUTCString(),
      'Foo': 'some-other-value',
      'Cache-Control': 'immutable'
    })
    return fetch(`${HOST}/test`, {
      method: 'HEAD',
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 304, 'revalidated cached req returns 304')
    t.equal(res.headers.get('Foo'), 'some-other-value', 'updated Foo')
    t.equal(res.headers.get('Cache-Control'), 'immutable', 'new C-Ctrl')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, Buffer.from(''), 'HEAD request has empty body')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'local cache not stale after update')
    t.equal(res.headers.get('Foo'), 'some-other-value', 'updated Foo')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content again')
  })
})

test('refreshes cached request on HEAD request', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Age': '3000',
    'Date': new Date(new Date() - 800000).toUTCString(),
    'Last-Modified': new Date(new Date() - 800000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(304, 'why a body', {
      'Age': '3000'
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 304, 'revalidated cached req returns 304')
    t.deepEqual(
      res.headers.get('Warning'),
      null,
      'successfully revalidated -- no warnings'
    )
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got original cached content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'local cache not stale after update')
    // TODO - pending https://github.com/pornel/http-cache-semantics/issues/3
    // t.match(
    //   res.headers.get('Warning'),
    //   /^113 localhost/,
    //   'heurisic usage warning header added'
    // )
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content again')
  })
})

test('original Warning header 1xx removed on cache hit', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT, {
    'Warning': '199 localhost welp',
    'Cache-Control': 'max-age=10000000'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'non-stale cached res has 200 status')
    t.equal(res.headers.get('Warning'), null, 'no Warning header because 1xx')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('Warning header 2xx retained on cache hit', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT, {
    'cache-control': 'max-age=300',
    'Warning': '200 localhost welp'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'non-stale cached res has 200 status')
    t.equal(
      res.headers.get('Warning'), '200 localhost welp', '2xx warning retained'
    )
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
  })
})

test('invalidates cache on put/post/delete', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'immutable',
    'Foo': 'old',
    'Date': new Date().toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    t.equal(res.headers.get('Foo'), 'old', 'got old Foo header')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.post('/test').reply(201)
    return fetch(`${HOST}/test`, {
      method: 'post',
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    t.equal(res.status, 201, 'status code from POST')
    return res.buffer()
  }).then(body => {
    srv.get('/test').reply(200, 'another', {
      'Cache-Control': 'immutable',
      'Foo': 'another',
      'Date': new Date().toUTCString()
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'got a proper 200 code')
    t.equal(res.headers.get('Foo'), 'another', 'got new Foo header')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, Buffer.from('another'), 'got new remote content')
    srv.put('/test').reply(201)
    return fetch(`${HOST}/test`, {
      method: 'put',
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    t.equal(res.status, 201, 'status code from POST')
    return res.buffer()
  }).then(body => {
    srv.get('/test').reply(200, 'new', {
      'Cache-Control': 'immutable',
      'Foo': 'new',
      'Date': new Date().toUTCString()
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'got a proper 200 code')
    t.equal(res.headers.get('Foo'), 'new', 'got new Foo header')
    return res.buffer()
  })
})

test('request failures invalidate cache', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'must-revalidate',
    'ETag': 'thisisanetag',
    'Date': new Date().toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => {
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    srv.get('/test').reply(500)
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    t.equal(res.status, 500, 'got a 500 because must-revalidate')
    srv.get('/test').reply(200, CONTENT, {
      'Cache-Control': 'must-revalidate',
      'ETag': 'thisisanetag',
      'Date': new Date().toUTCString()
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'original was invalidated -- fresh round-trip')
    return res.buffer()
  }).then(() => {
    srv.put('/test').reply(500)
    return fetch(`${HOST}/test`, {
      method: 'put',
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    t.equal(res.status, 500, 'got a 500 because must-revalidate on PUT')
  })
})

test('uses GET cache if request is HEAD (without returning body)', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT)
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      method: 'head',
      cacheManager: CACHE,
      retry: { retries: 0 }
    })
  }).then(res => {
    t.equal(res.status, 200, 'HEAD hit cached path!')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, Buffer.from(''), 'no body')
  })
})

test('file handle not opened if body stream never used', t => {
  tnock(t, HOST).get('/test').reply(200, CONTENT)
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'Got a 200 response!')
    t.comment('TODO: this test is "ok" because it used to crash, but it needs to do the job some better way.')
  })
})

test('checks for staleness using Cache-Control: max-age', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'max-age=0'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE
  }).then(res => res.buffer()).then(() => {
    srv.get('/test').reply(304, 'feh', {
      'Cache-Control': 'max-age=1'
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 304, 'request revalidated')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'request no longer stale')
  })
})

test('does not store response if it has Cache-Control: no-store header', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'no-store'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE
  }).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'got content from original req')
    srv.get('/test').reply(200, 'feh')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE
    })
  }).then(res => {
    t.equal(res.status, 200, 'request made again -- no cache used')
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, Buffer.from('feh'), 'body from second request used')
  })
})

test('supports matching using Vary header', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Vary': 'Accept',
    'Cache-Control': 'immutable',
    'Content-Type': 'fullfat'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    headers: {
      'accept': 'fullfat'
    }
  }).then(res => res.buffer()).then(body => {
    t.deepEqual(body, CONTENT, 'got remote content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      headers: {
        'Accept': 'fullfat'
      }
    })
  }).then(res => {
    t.equal(res.status, 200, 'cached response used!')
    t.equal(
      res.headers.get('content-type'), 'fullfat', 'got original content-type'
    )
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content')
    srv.get('/test').reply(200, CONTENT, {
      'Cache-Control': 'cache-max=0',
      'Content-Type': 'corgi',
      'Vary': '*'
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      headers: {
        'Accept': 'corgi'
      }
    })
  }).then(res => {
    t.equal(res.status, 200, 'got 200 OK')
    t.equal(res.headers.get('content-type'), 'corgi', 'got new content-type')
    return res.buffer()
  }).then(() => {
    srv.get('/test').reply(200, CONTENT, {
      'Cache-Control': 'cache-max=0',
      'Content-Type': 'whatever'
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      headers: {
        'Accept': 'corgi'
      }
    })
  }).then(res => {
    t.equal(
      res.headers.get('content-type'),
      'whatever',
      'did a new, full request because Vary: *'
    )
  })
})

test('supports range caching (partial requests)')
test('Support Cache object injection')

test('mode: no-store', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, 'foo')
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(() => {
    t.comment('cache warmed up')
    srv.get('/test').reply(200, CONTENT, {
      'Foo': 'second req'
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      cache: 'no-store',
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'got 200 status')
    t.equal(res.headers.get('foo'), 'second req', 'request was redone')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got second request content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => res.buffer()).then(buf => {
    t.deepEqual(
      buf, Buffer.from('foo'), 'no-store request did not affect cache'
    )
  })
})

test('mode: default -> no-store', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, 'foo')
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(() => {
    t.comment('cache warmed up')
    srv.get('/test').reply(200, CONTENT, {
      'Foo': 'second req'
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0},
      headers: {
        'if-none-match': 'foo'
      }
    })
  }).then(res => {
    t.equal(res.status, 200, 'got 200 status')
    t.equal(
      res.headers.get('foo'),
      'second req',
      'request went out-- default acted like no-cache due to header'
    )
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got second request content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => res.buffer()).then(buf => {
    t.deepEqual(
      buf, Buffer.from('foo'), 'no-store request did not affect cache'
    )
  })
})

test('mode: reload', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, 'foo', {
    'Cache-Control': 'cache-max=0',
    'ETag': 'foobarbaz'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(() => {
    t.comment('cache warmed up')
    srv.get('/test').reply(function () {
      t.deepEqual(this.req.headers['if-none-match'], null, 'no etag sent')
      return [
        200,
        CONTENT,
        {'Foo': 'second req'}
      ]
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      cache: 'reload',
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'got 200 status')
    t.equal(res.headers.get('foo'), 'second req', 'request was redone')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got second request content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'reload request refreshed cache')
  })
})

test('mode: no-cache', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, 'foo', {
    'Cache-Control': 'cache-max=0',
    'ETag': 'foobarbaz'
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(() => {
    t.comment('cache warmed up')
    srv.get('/test').reply(function () {
      t.equal(this.req.headers['if-none-match'][0], 'foobarbaz', 'got etag')
      return [
        200,
        CONTENT,
        {'Foo': 'second req'}
      ]
    })
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      cache: 'no-cache',
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'got 200 status')
    t.equal(res.headers.get('foo'), 'second req', 'request was redone')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got second request content')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      retry: {retries: 0}
    })
  }).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'reload request refreshed cache')
  })
})

test('mode: force-cache', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'max-age=0',
    'Date': new Date().toUTCString(),
    'Last-Modified': new Date(new Date() - 1000000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    cache: 'force-cache',
    retry: {retries: 0}
  }).then(res => res.buffer()).then(() => {
    t.comment('cache warmed up')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      cache: 'force-cache',
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'got 200 status')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content even w/ stale cache')
  })
})

test('mode: only-if-cached', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    'Cache-Control': 'max-age=0',
    'Date': new Date().toUTCString(),
    'Last-Modified': new Date(new Date() - 1000000).toUTCString()
  })
  return fetch(`${HOST}/test`, {
    cacheManager: CACHE,
    retry: {retries: 0}
  }).then(res => res.buffer()).then(() => {
    t.comment('cache warmed up')
    return fetch(`${HOST}/test`, {
      cacheManager: CACHE,
      cache: 'only-if-cached',
      retry: {retries: 0}
    })
  }).then(res => {
    t.equal(res.status, 200, 'got 200 status')
    return res.buffer()
  }).then(body => {
    t.deepEqual(body, CONTENT, 'got cached content even w/ stale cache')
    return fetch(`${HOST}/other`, {
      cacheManager: CACHE,
      cache: 'only-if-cached',
      retry: {retries: 0}
    }).then(() => {
      throw new Error('not supposed to succeed!')
    }).catch(err => {
      t.equal(err.code, 'ENOTCACHED', 'did not even try to hit network')
    })
  })
})
