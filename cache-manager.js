'use strict'

const duck = require('protoduck')

// CacheManager
//
// This protocol defines the interface for a make-fetch-happen-compatible
// cache implementation. Anything that implements this may be passed in as
// make-fetch-happen's opts.cacheManager
//
// docs: https://developer.mozilla.org/en-US/docs/Web/API/Cache
//
// To implement this protocol, call it on a class and write the impls:
//
// const CacheManager = require('make-fetch-happen/cache-manager')
// class MyCache {
//   constructor (opts) { ... }
// }
//
// CacheManager.impl(MyCache, {
//   match (req) { ...get response... }, // -> fetch.Response
//   put (req, res) { ...insert into cache... }, // -> fetch.Response
//   delete (req) { ...remove from cache... } // -> Boolean
// })
//
module.exports = duck.define(['req', 'res'], {
  // Returns a Promise that resolves to the response associated with the first
  // matching request in the Cache object.
  match: ['req'],

  // Takes both a request and its response and adds it to the given cache.
  put: ['req', 'res'],

  // Finds the Cache entry whose key is the request, and if found, deletes the
  // Cache entry and returns a Promise that resolves to true. If no Cache entry
  // is found, it returns false.
  delete: ['req']
})
