'use strict'

const BB = require('bluebird')
const Buffer = require('safe-buffer').Buffer

const finished = BB.promisify(require('mississippi').finished)
const test = require('tap').test
const tnock = require('./util/tnock')

const CONTENT = Buffer.from('hello, world!', 'utf8')
const HOST = 'https://make-fetch-happen.npm'

const fetch = require('..')

test('requests remote content', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT)
  return fetch(`${HOST}/test`).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'request succeeded')
  })
})

test('supports http', t => {
  const srv = tnock(t, 'http://foo.npm')
  srv.get('/test').reply(200, CONTENT)
  return fetch(`http://foo.npm/test`).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'request succeeded')
  })
})

test('supports https', t => {
  const srv = tnock(t, 'https://foo.npm')
  srv.get('/test').reply(200, CONTENT)
  return fetch(`https://foo.npm/test`).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'request succeeded')
  })
})

test('500-level responses not thrown', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(500)
  return fetch(`${HOST}/test`, {retry: {retries: 0}}).then(res => {
    t.equal(res.status, 500, 'got regular response w/ errcode 500')
    srv.get('/test').reply(543)
    return fetch(`${HOST}/test`, {retry: {retries: 0}})
  }).then(res => {
    t.equal(res.status, 543, 'got regular response w/ errcode 543, as given')
  })
})

test('custom headers', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT, {
    foo: (req) => {
      t.equal(req.headers.test[0], 'ayy', 'got request header')
      return 'bar'
    }
  })
  return fetch(`${HOST}/test`, {
    headers: {
      test: 'ayy'
    }
  }).then(res => {
    t.equal(res.headers.get('foo'), 'bar', 'got response header')
  })
})

test('supports following redirects', t => {
  const srv = tnock(t, HOST)
  srv.get('/redirect').twice().reply(301, '', {
    'Location': `${HOST}/test`
  })
  srv.get('/test').reply(200, CONTENT)
  return fetch(`${HOST}/redirect`).then(res => {
    t.equal(res.status, 200, 'got the final status')
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'final req gave right body')
    return fetch(`${HOST}/redirect`, {
      redirect: 'manual'
    })
  }).then(res => {
    t.equal(res.status, 301, 'did not follow redirect with manual mode')
    return res.buffer()
  }).then(res => t.equal(res.length, 0, 'empty body'))
})

test('supports streaming content', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, CONTENT)
  return fetch(`${HOST}/test`).then(res => {
    let buf = []
    let bufLen = 0
    res.body.on('data', d => {
      buf.push(d)
      bufLen += d.length
    })
    return finished(res.body).then(() => Buffer.concat(buf, bufLen))
  }).then(body => t.deepEqual(body, CONTENT, 'streamed body ok'))
})

test('supports proxy configurations', t => {
  t.plan(3)
  // Gotta do this manually 'cause nock's interception breaks proxies
  const srv = require('http').createServer((req, res) => {
    t.equal(req.headers.host, 'npm.im:80', 'proxy target host received')
    res.write(CONTENT, () => {
      res.end(() => {
        req.socket.end(() => {
          srv.close(() => {
            t.ok(true, 'server closed')
          })
        })
      })
    })
  }).listen(9854)
  fetch(`http://npm.im/make-fetch-happen`, {
    proxy: 'http://localhost:9854',
    proxyOpts: {
      headers: {
        foo: 'bar'
      }
    },
    retry: {
      retries: 0
    }
  }).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'request succeeded')
  })
})

test('supports custom agent config', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').reply(200, function () {
    t.equal(this.req.headers['connection'][0], 'close', 'one-shot agent!')
    return CONTENT
  })
  return fetch(`${HOST}/test`, {
    agent: false
  }).then(res => {
    return res.buffer()
  }).then(buf => {
    t.deepEqual(buf, CONTENT, 'request succeeded')
  })
})

test('supports automatic agent pooling on unique configs')

test('handles 15 concurrent requests', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').times(15).delay(50).reply(200, CONTENT)
  const requests = []
  for (let i = 0; i < 15; i++) {
    requests.push(fetch(`${HOST}/test`).then(r => r.buffer()))
  }
  return BB.all(requests).then(results => {
    const expected = []
    for (let i = 0; i < 15; i++) {
      expected.push(CONTENT)
    }
    t.deepEqual(results, expected, 'all requests resolved successfully')
  })
})

test('supports opts.timeout for controlling request timeout time', t => {
  const srv = tnock(t, HOST)
  srv.get('/test').delay(10).reply(200, CONTENT)
  return fetch(`${HOST}/test`, {
    timeout: 1,
    retry: { retries: 0 }
  }).then(res => {
    throw new Error('unexpected req success')
  }).catch(err => {
    t.deepEqual(err.type, 'request-timeout', 'timeout error triggered')
  })
})

test('retries non-POST requests on timeouts', t => {
  const srv = tnock(t, HOST)
  let attempt = 0
  srv.get('/test').delay(50).times(4).reply(200, () => {
    attempt++
    if (attempt >= 4) {
      srv.get('/test').reply(200, CONTENT)
    }
    return null
  })
  return fetch(`${HOST}/test`, {
    timeout: 1,
    retry: {
      retries: 4,
      minTimeout: 5
    }
  }).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'request retried until success')
    srv.get('/test').delay(10).twice().reply(200)
    return fetch(`${HOST}/test`, {
      timeout: 1,
      retry: {retries: 1, minTimeout: 1}
    }).catch(err => {
      t.equal(err.type, 'request-timeout', 'exhausted timeout retries')
    })
  }).then(() => {
    srv.post('/test').delay(10).reply(201)
    return fetch(`${HOST}/test`, {
      method: 'POST',
      timeout: 1,
      retry: {retries: 1, minTimeout: 1}
    }).catch(err => {
      t.equal(
        err.type, 'request-timeout', 'POST got timeout error w/o retries'
      )
    })
  })
})

test('retries non-POST requests on 500 errors', t => {
  const srv = tnock(t, HOST)
  let attempt = 0
  srv.get('/test').times(4).reply(500, () => {
    attempt++
    if (attempt >= 4) {
      srv.get('/test').reply(200, CONTENT)
    }
    return 'NOPE'
  })
  return fetch(`${HOST}/test`, {
    retry: {
      retries: 4,
      minTimeout: 5
    }
  }).then(res => res.buffer()).then(buf => {
    t.deepEqual(buf, CONTENT, 'request retried until success')
    srv.get('/test').twice().reply(500)
    return fetch(`${HOST}/test`, {
      retry: {retries: 1, minTimeout: 1}
    })
  }).then(res => {
    t.equal(res.status, 500, 'got bad request back on failure')
  }).then(() => {
    srv.post('/test').reply(500)
    return fetch(`${HOST}/test`, {
      method: 'POST',
      retry: {retries: 5, minTimeout: 1}
    }).catch(err => {
      t.equal(
        err.type, 'request-timeout', 'got thrown error w/o retries'
      )
    })
  })
})

test('retries non-POST requests on ECONNRESET')
