'use strict'
const LRU = require('lru-cache')
const url = require('url')

let AGENT_CACHE = new LRU({ max: 50 })
let HttpsAgent
let HttpAgent

module.exports = getAgent

function getAgent (uri, opts) {
  const parsedUri = url.parse(typeof uri === 'string' ? uri : uri.url)
  const isHttps = parsedUri.protocol === 'https:'
  const pxuri = getProxyUri(uri, opts)

  const key = [
    `https:${isHttps}`,
    pxuri
    ? `proxy:${pxuri.protocol}//${pxuri.host}:${pxuri.port}`
    : '>no-proxy<',
    `ca:${(isHttps && opts.ca) || '>no-ca<'}`,
    `cert:${(isHttps && opts.cert) || '>no-cert<'}`,
    `key:${(isHttps && opts.key) || '>no-key<'}`
  ].join(':')

  if (opts.agent != null) { // `agent: false` has special behavior!
    return opts.agent
  }

  if (AGENT_CACHE.peek(key)) {
    return AGENT_CACHE.get(key)
  }

  if (pxuri) {
    const proxy = getProxy(pxuri, opts)
    AGENT_CACHE.set(key, proxy)
    return proxy
  }

  if (isHttps && !HttpsAgent) {
    HttpsAgent = require('agentkeepalive').HttpsAgent
  } else if (!isHttps && !HttpAgent) {
    HttpAgent = require('agentkeepalive')
  }
  const agent = isHttps ? new HttpsAgent({
    maxSockets: opts.maxSockets || 15,
    ca: opts.ca,
    cert: opts.cert,
    key: opts.key
  }) : new HttpAgent({
    maxSockets: opts.maxSockets || 15
  })
  AGENT_CACHE.set(key, agent)
  return agent
}

function checkNoProxy (uri) {
  // TODO
  return false
}

function getProxyUri (uri, opts) {
  const protocol = url.parse(uri).protocol

  const proxy = opts.proxy || (
    protocol === 'https:' && process.env.https_proxy
  ) || (
    protocol === 'http:' && (
      process.env.https_proxy || process.env.http_proxy || process.env.proxy
    )
  )

  const parsedProxy = (typeof proxy === 'string') ? url.parse(proxy) : proxy

  return !checkNoProxy(uri) && parsedProxy
}

let HttpProxyAgent
let HttpsProxyAgent
let SocksProxyAgent
function getProxy (proxyUrl, opts) {
  let popts = {
    host: proxyUrl.hostname,
    port: proxyUrl.port,
    protocol: proxyUrl.protocol,
    path: proxyUrl.path,
    ca: opts.ca,
    cert: opts.cert,
    key: opts.key,
    maxSockets: opts.maxSockets || 15
  }

  if (proxyUrl.protocol === 'http:') {
    if (!HttpProxyAgent) {
      HttpProxyAgent = require('http-proxy-agent')
    }

    return new HttpProxyAgent(popts)
  }
  if (proxyUrl.protocol === 'https:') {
    if (!HttpsProxyAgent) {
      HttpsProxyAgent = require('https-proxy-agent')
    }

    return new HttpsProxyAgent(popts)
  }
  if (proxyUrl.startsWith('socks')) {
    if (!SocksProxyAgent) {
      SocksProxyAgent = require('socks-proxy-agent')
    }

    return new SocksProxyAgent(popts)
  }
}
