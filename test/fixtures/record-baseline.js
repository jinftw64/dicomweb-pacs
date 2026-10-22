// How qido-baseline.json was recorded: the TG18 study in ./import was stored
// through the old DIMSE path (npm run import -> C-STORE) on commit 6ca7656, the
// server was queried with this script, and the raw output was reduced to the
// fixture (frame payloads hashed, /wadouri hashed per DICOM element).
// Usage: node record-baseline.js <baseUrl> <out.json>
/* eslint-disable no-restricted-syntax, no-await-in-loop, no-console */
const crypto = require('crypto');
const fs = require('fs');

const [base, out] = process.argv.slice(2);
const ST = '2.16.124.113543.6004.101.103.20021117.162333.1';
const SE = `${ST}.002`;
const SOP = `${ST}.002.005`;

const json = [
  '/rs/studies',
  '/rs/studies?limit=101&offset=0&fuzzymatching=false&includefield=00081030%2C00080060',
  '/rs/studies?limit=25&offset=0&fuzzymatching=false&includefield=00081030%2C00080060&PatientName=AAPM',
  '/rs/studies?PatientName=AAPM',
  '/rs/studies?PatientName=aapm',
  '/rs/studies?PatientName=*Test*',
  '/rs/studies?PatientName=ZZZ',
  '/rs/studies?PatientName=Test',
  '/rs/studies?PatientID=TG18-2002',
  '/rs/studies?PatientID=TG18',
  '/rs/studies?PatientID=nope',
  '/rs/studies?StudyDate=20201117',
  '/rs/studies?StudyDate=20201118',
  '/rs/studies?StudyDate=20200101-20211231',
  '/rs/studies?StudyDate=20210101-20211231',
  '/rs/studies?AccessionNumber=20022002',
  '/rs/studies?AccessionNumber=2002',
  '/rs/studies?ModalitiesInStudy=OT',
  '/rs/studies?ModalitiesInStudy=CT',
  '/rs/studies?StudyDescription=TG18',
  '/rs/studies?includefield=StudyDescription',
  '/rs/studies?includefield=00081030',
  `/rs/studies?StudyInstanceUID=${ST}`,
  '/rs/studies?StudyInstanceUID=1.2.3',
  '/rs/studies?offset=1',
  '/rs/studies?unknownparam=1',
  `/rs/studies/${ST}/series`,
  `/rs/studies/${ST}/series?includefield=00080021`,
  `/rs/studies/${ST}/series?Modality=OT`,
  `/rs/studies/${ST}/series?Modality=CT`,
  '/rs/studies/1.2.3/series',
  `/rs/studies/${ST}/metadata`,
  '/rs/studies/1.2.3/metadata',
  `/rs/studies/${ST}/series/${SE}/instances`,
  `/rs/studies/${ST}/series/${SE}/instances?offset=5`,
  `/rs/studies/${ST}/series/1.2.3/instances`,
  `/rs/studies/${ST}/series/${SE}/metadata`,
  `/rs/studies/${ST}/series/${SE}/instances/${SOP}/metadata`,
  `/rs/studies/${ST}/series/${SE}/instances/1.2.3/metadata`,
];

const binary = [
  `/rs/studies/${ST}/series/${SE}/instances/${SOP}/frames/1`,
  `/rs/studies/${ST}/series/${SE}/instances/${ST}.002.019/frames/1`,
  `/rs/studies/${ST}/series/${SE}/instances/1.2.3/frames/1`,
  `/wadouri?requestType=WADO&studyUID=${ST}&seriesUID=${SE}&objectUID=${SOP}&contentType=application%2Fdicom`,
  `/wadouri?studyUID=${ST}&seriesUID=${SE}&objectUID=1.2.3`,
  `/wadouri?studyUID=${ST}`,
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// the multipart boundary is random per response, so hash only the payload
function framePayload(buf, contentType) {
  const m = /boundary='([^']+)'/.exec(contentType || '');
  if (!m) return buf;
  const text = buf.toString('latin1');
  const start = text.indexOf('\r\n\r\n') + 4;
  const end = text.lastIndexOf(`\r\n--${m[1]}--`);
  return buf.subarray(start, end);
}

(async () => {
  const cases = [];
  for (const url of json) {
    const res = await fetch(base + url);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    cases.push({ url, kind: 'json', status: res.status, contentType: res.headers.get('content-type'), body });
  }
  for (const url of binary) {
    const res = await fetch(base + url);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type');
    cases.push({ url, kind: 'binary', status: res.status, contentType: ct, length: buf.length, sha256: sha(framePayload(buf, ct)) });
  }
  fs.writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
  for (const c of cases) console.log(c.status, Array.isArray(c.body) ? `[${c.body.length}]` : '', c.url);
})();
