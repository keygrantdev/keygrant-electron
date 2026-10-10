/**
 * The groups after the first ones (`LaterGroup`): the link `upgradeUrl`
 * answers, a reference on a payment link (`referencedLinks`, link.ts
 * `referencedLink`), and when a running trial reports its launch
 * (`trialReportDue`, trials.ts). The major a build runs as (`majors`) is
 * built in decisions.ts.
 */
import { TRIAL_REPORT_MS } from '../../src/offline.js'
import type { GroupInputs } from '../inputs.js'
import { DAY_MS, NOW } from './common.js'

const LINK = 'https://buy.stripe.com/test_abc'

/** An activation id, as `upgradeUrl` puts one on a link. */
const ACTIVATION = 'act_01HZXK4Q8R5T2V9WB3NC6MDE7F'

export function referencedLinks(): GroupInputs['referencedLinks'][] {
  const reference = ACTIVATION
  return [
    { name: 'no query: the reference added', link: LINK, reference },
    { name: 'parameters: kept as written and in order, the reference last', link: `${LINK}?prefilled_email=jo%40example.com&locale=fr`, reference },
    { name: 'a client_reference_id already there: replaced', link: `${LINK}?client_reference_id=act_1&locale=fr`, reference },
    { name: 'two client_reference_ids: one reference in their place', link: `${LINK}?client_reference_id=a&x=1&client_reference_id=b`, reference },
    { name: 'a client_reference_id with no value: replaced', link: `${LINK}?client_reference_id&x=1`, reference },
    { name: 'a name that only starts with client_reference_id: kept', link: `${LINK}?client_reference_id_old=1`, reference },
    { name: 'a fragment: kept, after the query', link: `${LINK}#checkout`, reference },
    { name: 'parameters and a fragment', link: `${LINK}?locale=fr#checkout`, reference },
    { name: 'empty parameters: left out', link: `${LINK}?&locale=fr&&`, reference },
    { name: 'an empty query: the reference alone', link: `${LINK}?`, reference },
    { name: 'a value with = in it: kept as written', link: `${LINK}?redirect=a=b`, reference },
    { name: 'another host, a port and a deeper path: kept', link: 'https://pay.example.com:8443/buy/sluice?plan=pro', reference },
  ]
}

export function trialReportDue(): GroupInputs['trialReportDue'][] {
  const now = NOW
  return [
    { name: 'neither stamped: due', state: {}, now },
    { name: 'reported a day ago: due', state: { trialReportedAt: NOW - TRIAL_REPORT_MS }, now },
    { name: 'reported a millisecond under a day ago: not due', state: { trialReportedAt: NOW - TRIAL_REPORT_MS + 1 }, now },
    { name: 'a trial answer a day ago: due', state: { trialAt: NOW - TRIAL_REPORT_MS }, now },
    { name: 'a trial answer a millisecond under a day ago: not due', state: { trialAt: NOW - TRIAL_REPORT_MS + 1 }, now },
    { name: 'an old trial answer, a recent report: not due', state: { trialAt: NOW - 3 * DAY_MS, trialReportedAt: NOW - 1000 }, now },
    { name: 'a recent trial answer, an old report: not due', state: { trialAt: NOW - 1000, trialReportedAt: NOW - 3 * DAY_MS }, now },
    { name: 'both a day or more ago: due', state: { trialAt: NOW - 2 * DAY_MS, trialReportedAt: NOW - TRIAL_REPORT_MS }, now },
    { name: 'a report stamped ahead of now: not due', state: { trialReportedAt: NOW + 1000 }, now },
    { name: 'a trial answer stamped ahead of now: not due', state: { trialAt: NOW + 1000 }, now },
  ]
}
