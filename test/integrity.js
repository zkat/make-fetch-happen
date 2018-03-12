'use strict'

const Buffer = require('safe-buffer').Buffer

const ssri = require('ssri')
const test = require('tap').test
const tnock = require('./util/tnock')

const CACHE = require('./util/test-dir')(__filename)
const CONTENT = Buffer.from('hello, world!', 'utf8')
const CONTENT_GZ = Buffer.from('H4sIAAAAAAAA/8tIzcnJ11Eozy/KSVEEABONmFgNAAAA', 'utf8')
const INTEGRITY = ssri.fromData(CONTENT)
const INTEGRITY_GZ = ssri.fromData(CONTENT_GZ)
const HOST = 'https://make-fetch-happen-safely.npm'

const fetch = require('..').defaults({retry: false})

test('basic integrity verification', t => {
  const srv = tnock(t, HOST)
  srv.get('/wowsosafe').reply(200, CONTENT)
  srv.get('/wowsobad').reply(200, Buffer.from('pwnd'))
  const safetch = fetch.defaults({
    integrity: INTEGRITY
  })
  return safetch(`${HOST}/wowsosafe`).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'good content passed scrutiny 👍🏼')
    return safetch(`${HOST}/wowsobad`).then(res => {
      return res.buffer()
    }).then(buf => {
      throw new Error(`bad data: ${buf.toString('utf8')}`)
    }).catch(err => {
      t.equal(err.code, 'EINTEGRITY', 'content failed checksum!')
    })
  })
})

test('picks the "best" algorithm', t => {
  const integrity = ssri.fromData(CONTENT, {
    algorithms: ['md5', 'sha384', 'sha1', 'sha256']
  })
  integrity['md5'][0].digest = 'badc0ffee'
  integrity['sha1'][0].digest = 'badc0ffee'
  const safetch = fetch.defaults({integrity})
  const srv = tnock(t, HOST)
  srv.get('/good').times(3).reply(200, CONTENT)
  srv.get('/bad').reply(200, 'pwnt')
  return safetch(`${HOST}/good`).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'data passed integrity check')
    return safetch(`${HOST}/bad`).then(res => {
      return res.buffer()
    }).then(buf => {
      throw new Error(`bad data: ${buf.toString('utf8')}`)
    }).catch(err => {
      t.equal(err.code, 'EINTEGRITY', 'content validated with either sha256 or sha384 (likely the latter)')
    })
  }).then(() => {
    // invalidate sha384. sha256 is still valid, in theory
    integrity['sha384'][0].digest = 'pwnt'
    return safetch(`${HOST}/good`).then(res => {
      return res.buffer()
    }).then(buf => {
      throw new Error(`bad data: ${buf.toString('utf8')}`)
    }).catch(err => {
      t.equal(err.code, 'EINTEGRITY', 'strongest algorithm (sha384) treated as authoritative -- sha256 not used')
    })
  }).then(() => {
    // remove bad sha384 altogether. sha256 remains valid
    delete integrity['sha384']
    return safetch(`${HOST}/good`).then(res => res.buffer())
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'data passed integrity check with sha256')
  })
})

test('supports multiple hashes per algorithm', t => {
  const ALTCONTENT = Buffer.from('alt-content is like content but not really')
  const integrity = ssri.fromData(CONTENT, {
    algorithms: ['md5', 'sha384', 'sha1', 'sha256']
  }).concat(ssri.fromData(ALTCONTENT, {
    algorithms: ['sha384']
  }))
  const safetch = fetch.defaults({integrity})
  const srv = tnock(t, HOST)
  srv.get('/main').reply(200, CONTENT)
  srv.get('/alt').reply(200, ALTCONTENT)
  srv.get('/bad').reply(200, 'nope')
  return safetch(`${HOST}/main`).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'main content validated against sha384')
    return safetch(`${HOST}/alt`).then(res => res.buffer())
  }).then(buf => {
    t.deepEqual(buf, ALTCONTENT, 'alt content validated against sha384')
    return safetch(`${HOST}/bad`).then(res => res.buffer()).then(buf => {
      throw new Error(`bad data: ${buf.toString('utf8')}`)
    }).catch(err => {
      t.equal(err.code, 'EINTEGRITY', 'only the two valid contents pass')
    })
  })
})

test('checks integrity on cache fetch too', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT)
  const safetch = fetch.defaults({
    cacheManager: CACHE,
    integrity: INTEGRITY,
    cache: 'must-revalidate'
  })
  return safetch(`${HOST}/test`).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'good content passed scrutiny 👍🏼')
    srv.get('/test').reply(200, 'nope')
    return safetch(`${HOST}/test`).then(res => res.buffer()).then(buf => {
      throw new Error(`bad data: ${buf.toString('utf8')}`)
    }).catch(err => {
      t.equal(err.code, 'EINTEGRITY', 'cached content failed checksum!')
    })
  }).then(() => {
    srv.get('/test').reply(200, 'nope')
    return safetch(`${HOST}/test`, {
      // try to use local cached version
      cache: 'force-cache',
      integrity: {algorithm: 'sha512', digest: 'doesnotmatch'}
    }).then(res => res.buffer()).then(buf => {
      throw new Error(`bad data: ${buf.toString('utf8')}`)
    }).catch(err => {
      t.equal(err.code, 'EINTEGRITY', 'cached content failed checksum!')
    })
  })
})

test('basic integrity verification with gzip content', t => {
  const srv = tnock(t, HOST)
  srv.get('/wowsosafe').reply(200, CONTENT_GZ, { 'Content-Type': 'application/x-tgz', 'Content-Encoding': 'x-gzip' })
  const safetch = fetch.defaults({
    integrity: INTEGRITY_GZ
  })
  return safetch(`${HOST}/wowsosafe`).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT_GZ, 'good content passed scrutiny 👍🏼')
  })
})
