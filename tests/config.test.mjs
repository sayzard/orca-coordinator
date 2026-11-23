import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLanguage, languageName } from '../cli/lib/config.mjs'

test('board language comes from COORD_LANG, then the POSIX locale', () => {
  assert.equal(detectLanguage({ COORD_LANG: 'ko' }), 'ko')
  assert.equal(detectLanguage({ LANG: 'ko_KR.UTF-8' }), 'ko')
  assert.equal(detectLanguage({ LC_ALL: 'en_US.UTF-8', LANG: 'ko_KR.UTF-8' }), 'en')
  assert.equal(detectLanguage({ LANG: 'C' }), 'en')
})

test('language names for prompts', () => {
  assert.equal(languageName('ko'), 'Korean')
  assert.equal(languageName('en'), 'English')
  assert.equal(languageName('pt'), 'pt')
})
