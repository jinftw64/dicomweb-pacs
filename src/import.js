/* eslint-disable no-console */
// Copies DICOM files into the storage folder as <StudyInstanceUID>/<SOPInstanceUID>,
// the layout the WADO routes and the QIDO index read. The server does not need
// to be running; new studies show up on the next query.
//
// usage: npm run import [-- <source folder>]   (default: ./import)
const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');
const { isUid } = require('./dicomIndex');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });
}

function importFiles(sourcePath, storagePath) {
  const result = { imported: [], skipped: [], failed: [] };
  walk(sourcePath)
    .sort()
    .forEach((file) => {
      let studyUid;
      let sopUid;
      try {
        const dataset = dicomParser.parseDicom(fs.readFileSync(file), { untilTag: 'x7fe00010' });
        studyUid = dataset.string('x0020000d');
        sopUid = dataset.string('x00080018');
      } catch (error) {
        result.failed.push({ file, reason: `not a DICOM file: ${error.message || error}` });
        return;
      }
      // the UIDs become path segments, so only accept real UIDs
      if (!isUid(studyUid) || !isUid(sopUid)) {
        result.failed.push({ file, reason: 'missing or invalid StudyInstanceUID/SOPInstanceUID' });
        return;
      }
      const target = path.join(storagePath, studyUid, sopUid);
      if (fs.existsSync(target)) {
        result.skipped.push({ file, target });
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
      result.imported.push({ file, target });
    });
  return result;
}

module.exports = { importFiles };

if (require.main === module) {
  // eslint-disable-next-line global-require
  const config = require('config');
  const source = path.resolve(process.argv[2] || path.join(__dirname, '../import'));
  const storage = path.resolve(config.get('storagePath'));
  const { imported, skipped, failed } = importFiles(source, storage);
  imported.forEach(({ file, target }) => console.log(`imported ${file} -> ${target}`));
  skipped.forEach(({ file }) => console.log(`already stored, skipped ${file}`));
  failed.forEach(({ file, reason }) => console.error(`FAILED ${file}: ${reason}`));
  console.log(`${imported.length} imported, ${skipped.length} skipped, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
}
