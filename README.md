# make-fetch-happen [![npm version](https://img.shields.io/npm/v/make-fetch-happen.svg)](https://npm.im/make-fetch-happen) [![license](https://img.shields.io/npm/l/make-fetch-happen.svg)](https://npm.im/make-fetch-happen) [![Travis](https://img.shields.io/travis/zkat/make-fetch-happen.svg)](https://travis-ci.org/zkat/make-fetch-happen) [![AppVeyor](https://ci.appveyor.com/api/projects/status/github/zkat/make-fetch-happen?svg=true)](https://ci.appveyor.com/project/zkat/make-fetch-happen) [![Coverage Status](https://coveralls.io/repos/github/zkat/make-fetch-happen/badge.svg?branch=latest)](https://coveralls.io/github/zkat/make-fetch-happen?branch=latest)


[`make-fetch-happen`](https://github.com/zkat/make-fetch-happen) is a Node.js library that implements the [`fetch` API](https://fetch.spec.whatwg.org/), including cache support, request pooling, proxies, retries, and more!

## Install

`$ npm install --save make-fetch-happen`

## Table of Contents

* [Example](#example)
* [Features](#features)
* [Contributing](#contributing)
* [API](#api)
  * [`fetch`](#fetch)
  * [`fetch.defaults`](#fetch-defaults)
  * [`node-fetch` options](#node-fetch-options)
  * [`make-fetch-happen` options](#extra-options)
    * [`opts.cacheManager`](#opts-cache-manager)
    * [`opts.cache`](#opts-cache)
    * [`opts.proxy`](#opts-proxy)
    * [`opts.retry`](#opts-retry)
    * [`opts.integrity`](#opts-integrity)
* [Message From Our Sponsors](#wow)

### Example

```javascript
const fetch = require('make-fetch-happen')

fetch('https://registry.npmjs.org/make-fetch-happen', {
  cacheManager: './my-cache' // cache will be written here
}).then(res => res.json()).then(body => {
  console.log(`got ${body.name} from web`)
  return fetch('https://registry.npmjs.org/make-fetch-happen', {
    cacheManager: './my-cache',
    cache: 'no-cache' // forces a conditional request
  })
}).then(res => {
  console.log(res.status) // 304! cache validated!
  return res.json().then(body => {
    console.log(`got ${body.name} from cache`)
  })
})
```

### Features

* Follows `fetch` spec, using [`node-fetch`](https://npm.im/node-fetch) under the hood.
* Request pooling out of the box
* Quite fast, really
* Automatic HTTP-semantics-aware request retries
* Proxy support (http, https, socks, socks4, socks5, pac)
* Built-in request caching following full HTTP caching rules (`Cache-Control`, `ETag`, `304`s, cache fallback on error, etc).
* Customize cache storage with any [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache)-compliant `Cache` instance. Cache to Redis!
* Node.js Stream support
* Transparent gzip and deflate support
* (PENDING) Range request caching and resuming
* (PENDING) [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) support

### Contributing

The make-fetch-happen team enthusiastically welcomes contributions and project participation! There's a bunch of things you can do if you want to contribute! The [Contributor Guide](CONTRIBUTING.md) has all the information you need for everything from reporting bugs to contributing entire new features. Please don't hesitate to jump in if you'd like to, or even ask us questions if something isn't clear.

### API

#### <a name="fetch"></a> `> fetch(uriOrRequest, [opts]) -> Promise<Response>`

This function implements most of the [`fetch` API](https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch): given a `uri` string or a `Request` instance, it will fire off an http request and return a Promise containing the relevant response.

If `opts` is provided, the [`node-fetch`-specific options](#node-fetch-options) will be passed to that library. There are also [additional options](#extra-options) specific to make-fetch-happen that add various features, such as HTTP caching, integrity verification, proxy support, and more.

##### Example

```javascript
fetch('https://google.com').then(res => res.buffer())
```

#### <a name="fetch-defaults"></a> `> fetch.defaults([defaultUrl], [defaultOpts])`

Returns a new `fetch` function that will call `make-fetch-happen` using `defaultUrl` and `defaultOpts` as default values to any calls.

A defaulted `fetch` will also have a `.defaults()` method, so they can be chained.

##### Example

```javascript
const fetch = require('make-fetch-happen').defaults({
  cacheManager: './my-local-cache'
})

fetch('https://registry.npmjs.org/make-fetch-happen') // will always use the cache
```

#### <a name="node-fetch-options"></a> `> node-fetch options`

The following options for `node-fetch` are used as-is:

* method
* body
* redirect
* follow
* timeout
* compress
* size

These other options are modified or augmented by make-fetch-happen:

* headers - Default `User-Agent` set to make-fetch happen. `Connection` is set to `keep-alive` or `close` automatically depending on `opts.agent`.
* agent
  * If agent is null, an http or https Agent will be automatically used. By default, these will be `http.globalAgent` and `https.globalAgent`.
  * If [`opts.proxy`](#opts-proxy) is provided and `opts.agent` is null, the agent will be set to a [`proxy-agent`](https://npm.im/proxy-agent) instance.
  * If `opts.agent` is `false` or an object is provided, it will be used as the request-pooling agent for this request.

For more details, see [the documentation for `node-fetch` itself](https://github.com/bitinn/node-fetch#options).

#### <a name="extra-options"></a> `> make-fetch-happen options`

make-fetch-happen augments the `node-fetch` API with additional features available through extra options. The following extra options are available:

* [`opts.cacheManager`](#opts-cache-manager) - Cache target to read/write
* [`opts.cache`](#opts-cache) - `fetch` cache mode. Controls cache *behavior*.
* [`opts.proxy`](#opts-proxy) - Proxy agent
* [`opts.retry`](#opts-retry) - Request retry settings
* [`opts.integrity`](#opts-integrity) - [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) metadata.

#### <a name="opts-cache-manager"></a> `> opts.cacheManager`

Either a `String` or a `Cache`. If the former, it will be assumed to be a `Path` to be used as the cache root for [`cacache`](https://npm.im/cacache).

If an object is provided, it will be assumed to be a compliant [`Cache` instance](https://developer.mozilla.org/en-US/docs/Web/API/Cache). Only `Cache.match()`, `Cache.put()`, and `Cache.delete()` are required. Options objects will not be passed in to `match()` or `delete()`.

By implementing this API, you can customize the storage backend for make-fetch-happen itself -- for example, you could implement a cache that uses `redis` for caching, or simply keeps everything in memory. Most of the caching logic exists entirely on the make-fetch-happen side, so the only thing you need to worry about is reading, writing, and deleting, as well as making sure `fetch.Response` objects are what gets returned.

You can refer to `cache.js` in the make-fetch-happen source code for a reference implementation.

##### Example

```javascript
fetch('https://registry.npmjs.org/make-fetch-happen', {
  cacheManager: './my-local-cache'
}) // -> 200-level response will be written to disk

fetch('https://npm.im/cacache', {
  cacheManager: new MyCustomRedisCache(process.env.PORT)
}) // -> 200-level response will be written to redis
```

A possible (minimal) implementation for `MyCustomRedisCache`:

```javascript
const bluebird = require('bluebird')
const redis = require("redis")
bluebird.promisifyAll(redis.RedisClient.prototype)
class MyCustomRedisCache {
  constructor (opts) {
    this.redis = redis.createClient(opts)
  }
  match (req) {
    return this.redis.getAsync(req.url).then(res => {
      if (res) {
        const parsed = JSON.parse(res)
        return new fetch.Response(parsed.body, {
          url: req.url,
          headers: parsed.headers,
          status: 200
        })
      }
    })
  }
  put (req, res) {
    return res.buffer().then(body => {
      return this.redis.setAsync(req.url, JSON.stringify({
        body: body,
        headers: res.headers.raw()
      }))
    }).then(() => {
      // return the response itself
      return res
    })
  }
  'delete' (req) {
    return this.redis.unlinkAsync(req.url)
  }
}
```

#### <a name="opts-cache"></a> `> opts.cache`

This option follows the standard `fetch` API cache option. This option will do nothing if [`opts.cacheManager`](#opts-cache-manager) is null. The following values are accepted (as strings):

* `default` - Fetch will inspect the HTTP cache on the way to the network. If there is a fresh response it will be used. If there is a stale response a conditional request will be created, and a normal request otherwise. It then updates the HTTP cache with the response.
* `no-store` - Fetch behaves as if there is no HTTP cache at all.
* `reload` - Fetch behaves as if there is no HTTP cache on the way to the network. Ergo, it creates a normal request and updates the HTTP cache with the response.
* `no-cache` - Fetch creates a conditional request if there is a response in the HTTP cache and a normal request otherwise. It then updates the HTTP cache with the response.
* `force-cache` - Fetch uses any response in the HTTP cache matching the request, not paying attention to staleness. If there was no response, it creates a normal request and updates the HTTP cache with the response.
* `only-if-cached` - Fetch uses any response in the HTTP cache matching the request, not paying attention to staleness. If there was no response, it returns a network error. (Can only be used when request’s mode is "same-origin". Any cached redirects will be followed assuming request’s redirect mode is "follow" and the redirects do not violate request’s mode.)

(Note: option descriptions are taken from https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)

##### Example

```javascript
// Will error with ENOTCACHED if we haven't already cached this url
fetch('https://registry.npmjs.org/make-fetch-happen', {
  cacheManager: './my-cache',
  cache: 'only-if-cached'
})

// Will refresh any local content and cache the new response
fetch('https://registry.npmjs.org/make-fetch-happen', {
  cacheManager: './my-cache',
  cache: 'reload'
})

// Will use any local data, even if stale. Otherwise, will hit network.
fetch('https://registry.npmjs.org/make-fetch-happen', {
  cacheManager: './my-cache',
  cache: 'force-cache'
})
```

#### <a name="opts-proxy"></a> `> opts.proxy`

A string URI or an object with options to be passed directly to [`proxy-agent`](https://npm.im/proxy-agent). Options available may vary depending on the proxy type. Refer the `proxy-agent`'s documentation for more details.

##### Example

```javascript
fetch('https://registry.npmjs.org/make-fetch-happen', {
  proxy: 'https://corporate.yourcompany.proxy:4445'
})

fetch('https://registry.npmjs.org/make-fetch-happen', {
  proxy: {
    protocol: 'https:',
    hostname: 'corporate.yourcompany.proxy',
    port: 4445,
    ca: process.env.CERTIFICATE_AUTHORITY
  }
})
```

#### <a name="opts-retry"></a> `> opts.retry`

An object that can be used to tune request retry settings. Requests are retried if they result in a `500`-level http status, or if the request fails entirely with an error. make-fetch-happen will never retry `POST` requests - it will only retry idempotent requests (GET, HEAD, PUT, DELETE, PATCH, etc), and those only if `opts.body` is NOT a stream.

If `opts.retry` is `false`, requests will never be retried.

The following retry options are available:

* retries
* factor
* minTimeout
* maxTimeout
* randomize

For details on what each of these do, refer to the [`retry`](https://npm.im/retry) documentation.

##### Example

```javascript
fetch('https://flaky.site.com', {
  retry: {
    retries: 10,
    randomize: true
  }
})

fetch('http://reliable.site.com', {
  retry: false
})
```

#### <a name="opts-integrity"></a> `> opts.integrity`

Matches the response body against the given [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) metadata. If verification fails, the request will fail with an `EBADCHECKSUM` error.

`integrity` may either be a string or an [`ssri`](https://npm.im/ssri) `Integrity`-like.

##### Example

```javascript
fetch('https://registry.npmjs.org/make-fetch-happen/-/make-fetch-happen-1.0.0.tgz', {
  integrity: 'sha1-o47j7zAYnedYFn1dF/fR9OV3z8Q='
}) // -> ok

fetch('https://malicious-registry.org/make-fetch-happen/-/make-fetch-happen-1.0.0.tgz'. {
  integrity: 'sha1-o47j7zAYnedYFn1dF/fR9OV3z8Q='
}) // Error: EBADCHECKSUM
```

### <a name="wow"></a> Message From Our Sponsors

![](stop.gif)

![](happening.gif)
