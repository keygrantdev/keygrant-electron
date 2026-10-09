/**
 * The wire (wire.ts): the server's error words (`mapServerError`,
 * `refusalOf`), what a person entered (`enteredKey`, `trimDeviceName`), no
 * answer (`noAnswer`), and the shapes of the answers (`parseLeaseBody`,
 * `parseTrialBody`).
 */
import { MAX_DEVICE_NAME, MAX_KEY } from '../../src/wire.js'
import type { GroupInputs } from '../inputs.js'
import { DAY_MS, NOW } from './common.js'

const ERROR_WORDS = ['invalid-key', 'limit', 'revoked', 'expired', 'deactivated', 'upgrade-required', 'update-required', 'device']

export function mapServerError(): GroupInputs['mapServerError'][] {
  return [...ERROR_WORDS, 'something-new', null, 42].map((error) => ({ error }))
}

export function refusalOf(): GroupInputs['refusalOf'][] {
  const words = ['upgrade-required', 'update-required', 'revoked', 'expired', 'deactivated', 'device', 'limit', 'invalid-key']
  return [...words, 'something-new', null, 42].map((error) => ({ error }))
}

export function enteredKey(): GroupInputs['enteredKey'][] {
  return [
    'sluice-aaaa-bbbb-cccc-dddd',
    '  SLUICE-AAAA-BBBB-CCCC-DDDD\n',
    '\tSLUICE-AAAA-BBBB-CCCC-DDDD\r\n',
    ' SLUICE-AAAA-BBBB-CCCC-DDDD ',
    '﻿SLUICE-AAAA-BBBB-CCCC-DDDD',
    ' SLUICE-AAAA-BBBB-CCCC-DDDD ',
    '',
    '   ',
    'K'.repeat(MAX_KEY),
    `${'K'.repeat(MAX_KEY)}\n`,
    'K'.repeat(MAX_KEY + 1),
    `${'k'.repeat(MAX_KEY - 1)}é`,
  ].map((input) => ({ input }))
}

export function trimDeviceName(): GroupInputs['trimDeviceName'][] {
  return [
    { input: 'Rae’s MacBook Pro', max: MAX_DEVICE_NAME },
    { input: 'x'.repeat(MAX_DEVICE_NAME), max: MAX_DEVICE_NAME },
    { input: 'x'.repeat(130), max: MAX_DEVICE_NAME },
    { input: `${'x'.repeat(MAX_DEVICE_NAME - 1)}\u{1F600}`, max: MAX_DEVICE_NAME },
    { input: `${'x'.repeat(MAX_DEVICE_NAME - 2)}\u{1F600}`, max: MAX_DEVICE_NAME },
    { input: 'é'.repeat(MAX_DEVICE_NAME + 1), max: MAX_DEVICE_NAME },
    // The cut falls just after a pair: the pair is kept whole.
    { input: `${'x'.repeat(MAX_DEVICE_NAME - 2)}\u{1F600}y`, max: MAX_DEVICE_NAME },
  ]
}

export function noAnswer(): GroupInputs['noAnswer'][] {
  return [200, 400, 401, 403, 404, 409, 429, 499, 500, 502, 503, 599].map((status) => ({ status }))
}

export function parseLeaseBody(): GroupInputs['parseLeaseBody'][] {
  return [
    { lease: 'header.payload.sig', activationId: 'act_9' },
    { lease: 'header.payload.sig' },
    { lease: 42, activationId: ['act'] },
    {},
    null,
    'a string',
    [],
  ].map((body) => ({ body }))
}

export function parseTrialBody(): GroupInputs['parseTrialBody'][] {
  return [
    { trialStart: NOW - DAY_MS, trialEndsAt: NOW + 6 * DAY_MS, lease: 'header.payload.sig' },
    { trialStart: NOW - DAY_MS, trialEndsAt: NOW + 6 * DAY_MS },
    { trialStart: NOW - DAY_MS, trialEndsAt: NOW + 6 * DAY_MS, lease: 7 },
    { trialStart: String(NOW), trialEndsAt: NOW },
    { trialStart: NOW },
    {},
    null,
    [],
  ].map((body) => ({ body }))
}
