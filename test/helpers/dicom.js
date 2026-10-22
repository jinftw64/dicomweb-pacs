// Writes minimal DICOM Part 10 files (explicit VR little endian, no pixel
// data) so the index can be tested with several patients/studies/series.
const fs = require('fs');
const path = require('path');
const dict = require('dicom-data-dictionary');

const LONG_VRS = ['OB', 'OW', 'OF', 'SQ', 'UT', 'UN'];

function encodeElement(tag, vr, value) {
  let data;
  if (vr === 'US') {
    const values = String(value).split('\\');
    data = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => data.writeUInt16LE(Number(v), i * 2));
  } else if (vr === 'UL') {
    data = Buffer.alloc(4);
    data.writeUInt32LE(Number(value));
  } else if (vr === 'OB') {
    data = Buffer.from(value);
  } else {
    data = Buffer.from(String(value), 'latin1');
    if (data.length % 2) {
      data = Buffer.concat([data, Buffer.from(vr === 'UI' ? '\0' : ' ')]);
    }
  }
  const head = Buffer.alloc(LONG_VRS.includes(vr) ? 12 : 8);
  head.writeUInt16LE(parseInt(tag.slice(0, 4), 16), 0);
  head.writeUInt16LE(parseInt(tag.slice(4), 16), 2);
  head.write(vr, 4, 'latin1');
  if (LONG_VRS.includes(vr)) {
    head.writeUInt32LE(data.length, 8);
  } else {
    head.writeUInt16LE(data.length, 6);
  }
  return Buffer.concat([head, data]);
}

/**
 * @param attrs { 'hex tag': value } dataset attributes; values are strings,
 *   multi-values separated by '\'
 */
function writeDicom(file, attrs) {
  const sopClass = attrs['00080016'] || '1.2.840.10008.5.1.4.1.1.7';
  const meta = Buffer.concat([
    encodeElement('00020001', 'OB', [0, 1]),
    encodeElement('00020002', 'UI', sopClass),
    encodeElement('00020003', 'UI', attrs['00080018']),
    encodeElement('00020010', 'UI', '1.2.840.10008.1.2.1'),
  ]);
  const dataset = Object.keys(attrs)
    .sort()
    .map((tag) => encodeElement(tag, dict.standardDataElements[tag].vr.slice(0, 2), attrs[tag]));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.alloc(128),
      Buffer.from('DICM'),
      encodeElement('00020000', 'UL', meta.length),
      meta,
      ...dataset,
    ]),
  );
}

// Stores one instance the way the import does: <storage>/<study>/<sop>
function storeInstance(storagePath, attrs) {
  const file = path.join(storagePath, attrs['0020000D'], attrs['00080018']);
  writeDicom(file, attrs);
  return file;
}

module.exports = { writeDicom, storeInstance };
