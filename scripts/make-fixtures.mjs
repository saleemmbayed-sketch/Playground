#!/usr/bin/env node
/**
 * Generates realistic TED-shaped fixture notices (multilingual value maps and all)
 * so the whole pipeline can be developed, demoed and tested with no network.
 * Dates are relative to today, so the demo always looks live.
 *   node scripts/make-fixtures.mjs [count]
 */
import fs from 'node:fs';
import path from 'node:path';

const count = Number.parseInt(process.argv[2] ?? '36', 10);
const out = path.resolve('data/fixtures/sample-notices.json');

const buyers = [
  ['Stadt Ulm, Zentrale Vergabestelle', 'DEU', ['DE144']],
  ['Bundesamt für Sicherheit in der Informationstechnik', 'DEU', ['DEA22']],
  ['Landeshauptstadt Stuttgart', 'DEU', ['DE111']],
  ['Freie und Hansestadt Hamburg, Finanzbehörde', 'DEU', ['DE600']],
  ['Bundesrechenzentrum GmbH', 'AUT', ['AT130']],
  ['Stadt Wien - Magistratsabteilung 01', 'AUT', ['AT130']],
  ['Kanton Zürich, Amt für Informatik', 'CHE', ['CH040']],
  ['Ministerie van Binnenlandse Zaken', 'NLD', ['NL332']],
  ['Région Auvergne-Rhône-Alpes', 'FRA', ['FRK2']],
  ['Comune di Milano', 'ITA', ['ITC4a']],
  ['Universitätsklinikum Freiburg', 'DEU', ['DE131']],
  ['Deutsche Rentenversicherung Bund', 'DEU', ['DE300']],
];

const subjects = [
  ['Rahmenvertrag Softwareentwicklung und DevOps-Dienstleistungen', 'Framework agreement for custom software development and DevOps services', ['72212000', '72000000'], 2_400_000],
  ['Beschaffung einer Dokumentenmanagement-Lösung (DMS)', 'Procurement of a document management system including migration', ['48311000', '48000000'], 780_000],
  ['IT-Sicherheitsaudit und Penetrationstests', 'IT security audit and penetration testing services', ['72500000', '79212000'], 190_000],
  ['Betrieb und Wartung der kommunalen Cloud-Plattform', 'Operation and maintenance of the municipal cloud platform', ['72514000', '72000000'], 3_100_000],
  ['Entwicklung eines Onlineportals für Bürgerdienste', 'Development of an online citizen services portal', ['72413000', '72212000'], 640_000],
  ['Lieferung von Notebooks und Peripheriegeräten', 'Supply of notebooks and peripheral devices', ['30213100', '30230000'], 1_250_000],
  ['Data-Warehouse-Modernisierung und Analytics', 'Data warehouse modernisation and analytics services', ['72316000', '72322000'], 950_000],
  ['Beratungsleistungen digitale Verwaltung', 'Consultancy services for digital administration transformation', ['72224000', '79411000'], 420_000],
  ['SAP S/4HANA Migrationsunterstützung', 'SAP S/4HANA migration support services', ['72265000', '72000000'], 1_800_000],
  ['Wartung Netzwerkinfrastruktur und WLAN', 'Maintenance of network infrastructure and campus WLAN', ['72315000', '32400000'], 510_000],
  ['Barrierefreiheits-Audit kommunaler Websites', 'Accessibility audit of municipal websites (WCAG 2.2)', ['72413000', '79417000'], 85_000],
  ['Schulungsleistungen IT-Grundschutz', 'Training services for IT baseline protection', ['80533100', '72000000'], 145_000],
];

// Competition notices only — award notices are generated separately below, with winners.
const noticeTypes = ['cn-standard', 'cn-social', 'pin-only', 'cn-desg'];
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const shift = (days) => iso(new Date(today.getTime() + days * 86_400_000));

const notices = [];
for (let i = 0; i < count; i += 1) {
  const [buyer, country, nuts] = buyers[i % buyers.length];
  const [deTitle, enTitle, cpv, baseValue] = subjects[i % subjects.length];
  const pubOffset = -(i % 6); // spread over the last 6 days
  const value = Math.round(baseValue * (0.6 + ((i * 37) % 90) / 100));
  const id = `${400000 + i * 137}-${today.getFullYear()}`;

  notices.push({
    'publication-number': id,
    'notice-title': { eng: [`${enTitle}`], deu: [`${deTitle}`] },
    'notice-type': noticeTypes[i % noticeTypes.length],
    'publication-date': `${shift(pubOffset)}Z`,
    'buyer-name': { deu: [buyer], eng: [buyer] },
    'buyer-country': [country],
    'place-of-performance': nuts,
    'classification-cpv': cpv,
    'deadline-receipt-tender-date-lot': [`${shift(7 + (i % 40))}+02:00`],
    'total-value': [{ amount: value, currency: 'EUR' }],
    'description-lot': {
      eng: [
        `${enTitle}. The contracting authority ${buyer} invites tenders for a contract with an estimated volume of ${value.toLocaleString('en-GB')} EUR. Services are to be delivered on site and remotely; the framework runs for 48 months with an option to extend. Tenderers must demonstrate at least three comparable public-sector references.`,
      ],
      deu: [`${deTitle}. Der Auftraggeber ${buyer} schreibt einen Rahmenvertrag mit einem geschätzten Volumen von ${value.toLocaleString('de-DE')} EUR aus.`],
    },
    'notice-language': ['deu'],
  });
}

/* ---------------------------------------------------------------------------
 * Historical contract award notices — the input to Re-tender Radar.
 *
 * Each buyer gets a run of awards on a fixed cycle, so the forecaster can
 * measure a real interval and project the next competition. The most recent
 * award is placed so that the predicted window lands near today: some already
 * open, some still upcoming. That makes the offline demo show a live radar.
 * ------------------------------------------------------------------------- */
const suppliers = [
  'Materna Information & Communications SE',
  'msg systems ag',
  'Capgemini Deutschland GmbH',
  'Atos Information Technology GmbH',
  'Accenture GmbH',
  'Bechtle AG',
  'T-Systems International GmbH',
  'Adesso SE',
  'PwC Strategy& Deutschland GmbH',
  'Computacenter AG & Co. oHG',
];

const monthsAgo = (m, day = 15) => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, day));
  return d.toISOString().slice(0, 10);
};

let awardSeq = 0;
buyers.forEach(([buyer, country, nuts], b) => {
  const [deTitle, enTitle, cpv, baseValue] = subjects[b % subjects.length];
  const cycle = [36, 48, 24][b % 3];              // observed re-tender interval
  const offset = [10, 16, 22, 8][b % 4];         // months until projected expiry
  // Jitter per buyer: real authorities do not all award in the same month, and
  // identical dates would give every buyer an identical predicted window.
  const jitter = (b % 5) - 2;
  const day = 4 + ((b * 3) % 22);
  const lastAwardMonthsAgo = cycle - offset + jitter;
  const incumbent = suppliers[b % suppliers.length];

  for (let k = 0; k < 3; k += 1) {
    const when = lastAwardMonthsAgo + k * cycle;
    if (when > 120) continue;                     // keep inside a 10-year history
    // The incumbent usually retains the contract; occasionally someone displaces them.
    const winner = k === 0 || b % 4 !== 0 ? incumbent : suppliers[(b + 3) % suppliers.length];
    const value = Math.round(baseValue * (0.75 + ((b * 13 + k * 7) % 50) / 100));
    awardSeq += 1;
    notices.push({
      'publication-number': `${900000 + awardSeq * 97}-${new Date(monthsAgo(when, day)).getFullYear()}`,
      'notice-title': {
        eng: [`Contract award: ${enTitle}`],
        deu: [`Vergabebekanntmachung: ${deTitle}`],
      },
      'notice-type': 'can-standard',
      'publication-date': `${monthsAgo(when, day)}Z`,
      'buyer-name': { deu: [buyer], eng: [buyer] },
      'buyer-country': [country],
      'buyer-identifier': [`ORG-${1000 + b}`],
      'place-of-performance': nuts,
      'classification-cpv': cpv,
      'total-value': [{ amount: value, currency: 'EUR' }],
      'winner-name': { eng: [winner], deu: [winner] },
      'winner-identifier': [`DE${300000000 + b * 7919}`],
      'description-lot': {
        eng: [
          `${enTitle}. ${buyer} awarded this contract to ${winner} with a total value of `
          + `${value.toLocaleString('en-GB')} EUR. The framework runs for ${cycle} months.`,
        ],
      },
      'notice-language': ['deu'],
    });
  }
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(notices, null, 2));
console.log(`wrote ${notices.length} fixture notices (${awardSeq} award notices) to ${out}`);
