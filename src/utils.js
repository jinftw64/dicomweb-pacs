const config = require('config');
const dict = require('dicom-data-dictionary');
const dimse = require('dicom-dimse-native');
const dict2 = require('@iwharris/dicom-data-dictionary');
const fs = require('fs');
const path = require('path');
const manager = require('simple-node-logger').createLogManager();
const { createIndex } = require('./dicomIndex');

// Per-file lock map to serialize concurrent recompression of the same file
const fileLocks = new Map();

function withFileLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  fileLocks.set(key, next.catch(() => {}));
  return next;
}

// make sure default directories exist
const logDir = config.get('logDir');
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(config.get('storagePath'), { recursive: true });

// create a rolling file logger based on date/time that fires process events
const opts = {
  errorEventName: 'error',
  logDirectory: logDir, // NOTE: folder must exist and be writable...
  fileNamePattern: 'roll-<DATE>.log',
  dateFormat: 'YYYY.MM.DD',
};
// manager.createConsoleAppender();
manager.createRollingFileAppender(opts);
const logger = manager.createLogger();

// QIDO is answered from an index of the storage folder instead of a C-FIND to
// our own DIMSE server (which forked the node process per query, see dicomIndex)
const index = createIndex(config.get('storagePath'), (file, error) => {
  logger.warn(`not indexed (${file}): ${error.message}`);
});

//------------------------------------------------------------------

const findDicomName = (name) => {
  // eslint-disable-next-line no-restricted-syntax
  for (const key of Object.keys(dict.standardDataElements)) {
    const value = dict.standardDataElements[key];
    if (value.name === name || name === key) {
      return key;
    }
  }
  return undefined;
};

const findVR = (name) => {
  const dataElement = dict2.get_element(name);
  if (dataElement) {
    return dataElement.vr;
  }
  return '';
};

//------------------------------------------------------------------

const utils = {
  findDicomName,
  findVR,
  getLogger: () => logger,
  fileExists: (pathname) =>
    new Promise((resolve, reject) => {
      fs.access(pathname, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    }),
  studyLevelTags: () => [
    '00080005',
    '00080020',
    '00080030',
    '00080050',
    '00080054',
    '00080056',
    '00080061',
    '00080090',
    '00081190',
    '00100010',
    '00100020',
    '00100030',
    '00100040',
    '0020000D',
    '00200010',
    '00201206',
    '00201208',
  ],
  seriesLevelTags: () => ['00080005', '00080054', '00080056', '00080060', '0008103E', '00081190', '0020000E', '00200011', '00201209'],
  imageLevelTags: () => ['00080016', '00080018', '00200013'],
  imageMetadataTags: () => [
    '00080016',
    '00080018',
    '00080060',
    '00280002',
    '00280004',
    '00280010',
    '00280011',
    '00280030',
    '00280100',
    '00280101',
    '00280102',
    '00280103',
    '00281050',
    '00281051',
    '00281052',
    '00281053',
    '00200013',
    '00200032',
    '00200037',
  ],
  compressFile: (inputFile, outputDirectory, transferSyntax) => {
    const ts = transferSyntax || config.get('transferSyntax');
    const tsSafe = ts.replace(/\./g, '_');
    const cacheDir = path.join(outputDirectory, '.cache', tsSafe);
    const cachedFile = path.join(cacheDir, path.basename(inputFile));
    const lockKey = `${inputFile}:${ts}`;

    return withFileLock(lockKey, async () => {
      // return cached file if it already exists
      try {
        await fs.promises.access(cachedFile);
        return cachedFile;
      } catch {
        // not cached yet, proceed with recompression
      }

      fs.mkdirSync(cacheDir, { recursive: true });

      return new Promise((resolve, reject) => {
        const j = {
          sourcePath: inputFile,
          storagePath: cacheDir,
          writeTransfer: ts,
          verbose: config.get('verboseLogging'),
          enableRecompression: true,
        };
        dimse.recompress(j, (result) => {
          if (result && result.length > 0) {
            try {
              const json = JSON.parse(result);
              if (json.code === 0) {
                resolve(cachedFile);
              } else {
                logger.error(`recompression failure (${inputFile}): ${json.message}`);
                reject(new Error(json.message));
              }
            } catch (error) {
              logger.error(error);
              logger.error(result);
              reject(error);
            }
          } else {
            logger.error('invalid result received');
            reject(new Error('invalid result received'));
          }
        });
      });
    });
  },
  doFind: async (queryLevel, query, defaults) => {
    // add query retrieve level
    const j = {
      tags: [
        {
          key: '00080052',
          value: queryLevel,
        },
      ],
    };

    // parse all include fields
    const includes = query.includefield;

    let tags = [];
    if (includes) {
      tags = includes.split(',');
    }
    tags.push(...defaults);

    // add parsed tags
    tags.forEach((element) => {
      const tagName = findDicomName(element) || element;
      j.tags.push({ key: tagName, value: '' });
    });

    // add search param
    let invalidInput = false;
    const minCharsQido = config.get('qidoMinChars');
    Object.keys(query).forEach((propName) => {
      const tag = findDicomName(propName);
      const vr = findVR(propName);
      if (tag) {
        let v = query[propName];
        // string vr types check
        if (['PN', 'LO', 'LT', 'SH', 'ST'].includes(vr)) {
          // just make sure to remove any wildcards from prefix and suffix
          v = v.replace(/^[*]/, '');
          v = v.replace(/[*]$/, '');

          // check if minimum number of chars are reached from input
          if (minCharsQido > v.length) {
            invalidInput = true;
          }
          // auto append wildcard
          if (config.get('qidoAppendWildcard')) {
            v += '*';
          }
        }
        j.tags.push({ key: tag, value: v });
      }
    });

    if (invalidInput) {
      return [];
    }

    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    return index.query(queryLevel, j.tags, config.get('source').aet).slice(offset);
  },
};
module.exports = utils;
