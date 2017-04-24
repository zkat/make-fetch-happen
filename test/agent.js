'use strict'

const test = require('tap').test
const getProcessEnv = require('../agent').getProcessEnv

test('extracts process env variables', t => {
  process.env = { TEST_ENV: 'test', ANOTHER_ENV: 'no' }

  t.deepEqual(getProcessEnv('test_ENV'), 'test', 'extracts single env')

  t.deepEqual(
    getProcessEnv(['not_existing_env', 'test_ENV', 'another_env']),
    'test',
    'extracts env from array of env names'
  )
  t.done()
})
