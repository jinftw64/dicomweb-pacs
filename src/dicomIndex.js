// In-process QIDO index over the DICOM files in the storage folder.
//
// This replaces the old round trip through dicom-dimse-native (C-FIND to our
// own SCP), which fork()ed the whole node process for every query. Matching,
// computed attributes and the DICOM JSON encoding deliberately mirror what the
// SQLite backend of dicom-dimse-native 2.4.6 returned, so the viewer sees the
// same responses as before. Deviations are marked "differs from dimse".
const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');
const dict = require('dicom-data-dictionary');

const LEVELS = ['PATIENT', 'STUDY', 'SERIES', 'IMAGE'];

// attributes the old SQLite backend stored, by level (dcmsqldb.cc definedAttribs)
const ATTRIBUTES = {
  PATIENT: [
    '00100030', '00100040', '00100010', '00100020', '00100032', '00101000',
    '00101001', '00102160', '00104000', '00201200', '00201202', '00201204',
  ],
  STUDY: [
    '00080005', '00080020', '00080030', '00200010', '00080050', '00080090',
    '00081030', '00081060', '0020000D', '00201070', '00081080', '00101010',
    '00101020', '00101030', '00102180', '001021B0', '00201206', '00201208',
    '00080061',
  ],
  SERIES: [
    '00200011', '0020000E', '00080060', '0008103E', '00080021', '00080031',
    '00180015', '00185100', '00181030', '00201209',
  ],
  IMAGE: [
    '00200013', '00080018', '00201041', '00080008', '00280008', '00280010',
    '00280011', '00281051', '00281050', '00280004', '00281053', '00281052',
    '00280002', '00280030', '00280100', '00280101', '00280102', '00280103',
    '00200032', '00200037', '00080016',
  ],
};

const TAG_LEVEL = {};
Object.entries(ATTRIBUTES).forEach(([level, tags]) => {
  tags.forEach((tag) => {
    TAG_LEVEL[tag] = level;
  });
});

const SPECIFIC_CHARACTER_SET = '00080005';
const QUERY_RETRIEVE_LEVEL = '00080052';
const RETRIEVE_AE_TITLE = '00080054';
const MODALITIES_IN_STUDY = '00080061';
const NUMBER_OF_STUDY_RELATED_SERIES = '00201206';
const NUMBER_OF_SERIES_RELATED_INSTANCES = '00201209';
const UNIQUE_KEY = {
  STUDY: '0020000D',
  SERIES: '0020000E',
  IMAGE: '00080018',
};

// UIDs are used as path segments of the storage folder, so only plain UIDs
// (digits and dots, at most 64 characters) are accepted anywhere
const isUid = (value) => typeof value === 'string' && value.length <= 64 && /^[0-9]+(\.[0-9]+)*$/.test(value);

const vrOf = (tag) => {
  const element = dict.standardDataElements[tag];
  return element ? element.vr.split(/[^A-Z]/)[0] : 'UN';
};

//------------------------------------------------------------------
// reading

// Reads the indexed attributes of one file as the strings the old backend
// stored: text values trimmed, US values as decimal with 0 treated as absent.
function readAttributes(file) {
  const dataset = dicomParser.parseDicom(fs.readFileSync(file), { untilTag: 'x7fe00010' });
  const attrs = {};
  Object.keys(TAG_LEVEL).forEach((tag) => {
    const key = `x${tag.toLowerCase()}`;
    if (!dataset.elements[key]) {
      return;
    }
    if (vrOf(tag) === 'US') {
      const value = dataset.uint16(key);
      if (value) {
        attrs[tag] = String(value);
      }
      return;
    }
    const value = dataset.string(key);
    if (value !== undefined) {
      attrs[tag] = value;
    }
  });
  return attrs;
}

// <storage>/<study dir>/<instance file>, as written by the import
function listFiles(storagePath) {
  const files = [];
  if (!fs.existsSync(storagePath)) {
    return files;
  }
  fs.readdirSync(storagePath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort()
    .forEach((dir) => {
      fs.readdirSync(path.join(storagePath, dir), { withFileTypes: true })
        .filter((f) => f.isFile() && !f.name.startsWith('.'))
        .map((f) => f.name)
        .sort()
        .forEach((name) => files.push(path.join(storagePath, dir, name)));
    });
  return files;
}

function pick(attrs, level) {
  const out = {};
  ATTRIBUTES[level].forEach((tag) => {
    if (attrs[tag] !== undefined) {
      out[tag] = attrs[tag];
    }
  });
  return out;
}

// Patients are keyed by id + name, everything below by its UID; the first file
// seen for an entity provides its attributes and duplicates are ignored.
function buildTree(files, onError) {
  const patients = new Map();
  const studies = new Map();
  const series = new Map();
  const images = new Map();

  files.forEach((file) => {
    let attrs;
    try {
      attrs = readAttributes(file);
    } catch (error) {
      onError(file, error);
      return;
    }
    const studyUid = attrs[UNIQUE_KEY.STUDY];
    const seriesUid = attrs[UNIQUE_KEY.SERIES];
    const sopUid = attrs[UNIQUE_KEY.IMAGE];
    if (!studyUid || !seriesUid || !sopUid) {
      onError(file, new Error('missing study, series or SOP instance UID'));
      return;
    }
    if (images.has(sopUid)) {
      return;
    }

    const patientKey = `${attrs['00100020'] || ''}\0${attrs['00100010'] || ''}`;
    if (!patients.has(patientKey)) {
      patients.set(patientKey, { attrs: pick(attrs, 'PATIENT'), children: [] });
    }
    if (!studies.has(studyUid)) {
      const study = { attrs: pick(attrs, 'STUDY'), children: [] };
      studies.set(studyUid, study);
      patients.get(patientKey).children.push(study);
    }
    if (!series.has(seriesUid)) {
      const serie = { attrs: pick(attrs, 'SERIES'), children: [] };
      series.set(seriesUid, serie);
      studies.get(studyUid).children.push(serie);
    }
    const image = { attrs: pick(attrs, 'IMAGE'), children: [] };
    images.set(sopUid, image);
    series.get(seriesUid).children.push(image);
  });

  return [...patients.values()];
}

//------------------------------------------------------------------
// matching

function likeToRegExp(pattern) {
  let source = '';
  [...pattern].forEach((c) => {
    if (c === '%') source += '[\\s\\S]*';
    else if (c === '_') source += '[\\s\\S]';
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${source}$`, 'i');
}

// One search key against one stored value, following the old SQL:
// - '*', '?', '^' or ' ' in the key: case-insensitive LIKE where only the first
//   '*' and the first '?' become wildcards (the old code replaced only once)
// - '-' in a DA/DT/TM key: inclusive range
// - otherwise exact, case-sensitive equality
function matches(tag, key, stored) {
  const value = stored || '';
  if (/[*?^ ]/.test(key)) {
    const pattern = key.toUpperCase().replace('*', '%').replace('?', '_');
    return likeToRegExp(pattern).test(value);
  }
  if (['DA', 'DT', 'TM'].includes(vrOf(tag)) && key.includes('-')) {
    // differs from dimse: it dropped the last character of the lower bound
    // and matched nothing for open ranges ("20200101-" or "-20201231")
    if (!value) {
      return false;
    }
    const [lower, upper] = key.split('-');
    return (!lower || value >= lower) && (!upper || value <= upper);
  }
  if (vrOf(tag) === 'UI' && key.includes('\\')) {
    // differs from dimse: it never matched UID lists
    return key.split('\\').includes(value);
  }
  return value === key;
}

//------------------------------------------------------------------
// DICOM JSON

// std::getline split as used by the old encoder: no trailing empty token
function splitValues(value) {
  if (value === '') {
    return [];
  }
  const parts = value.split('\\');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

// std::stoi / std::stof semantics, including stof's float precision
function toInt(s) {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}
function toFloat(s) {
  const n = Math.fround(parseFloat(s));
  return Number.isFinite(n) ? n : null;
}

function encode(tag, value) {
  const vr = vrOf(tag);
  let values;
  if (vr === 'PN') {
    values = [{ Alphabetic: value }];
  } else if (['IS', 'SL', 'SS', 'UL', 'US'].includes(vr)) {
    values = value === '' ? [null] : splitValues(value).map(toInt);
  } else if (['DS', 'FL', 'FD'].includes(vr)) {
    values = value === '' ? [null] : splitValues(value).map(toFloat);
  } else {
    values = splitValues(value);
  }
  if (values.length === 1 && values[0] === null) {
    return { vr };
  }
  return { Value: values, vr };
}

//------------------------------------------------------------------
// query

function normalizeKey(key) {
  return /^[0-9a-fA-F]{8}$/.test(key) ? key.toUpperCase() : undefined;
}

/**
 * Runs a QIDO query over a tree built by buildTree.
 * @param tree result of buildTree
 * @param queryLevel 'STUDY' | 'SERIES' | 'IMAGE'
 * @param tags [{ key, value }] like the old C-FIND request: return keys have
 *   an empty value, search keys a value; a later entry for the same key wins
 * @param retrieveAeTitle reported in RetrieveAETitle (0008,0054)
 */
function query(tree, queryLevel, tags, retrieveAeTitle) {
  const request = new Map();
  tags.forEach(({ key, value }) => {
    const tag = normalizeKey(key);
    if (tag) {
      request.set(tag, (value || '').trim());
    }
  });
  const depth = LEVELS.indexOf(queryLevel);
  if (depth < 1) {
    throw new Error(`unsupported query level ${queryLevel}`);
  }

  const keysAt = (level) => [...request.keys()].filter((tag) => TAG_LEVEL[tag] === level);
  const results = [];

  const visit = (node, levelIndex, inherited) => {
    const level = LEVELS[levelIndex];
    const own = {};
    let keep = true;

    keysAt(level).forEach((tag) => {
      const key = request.get(tag);
      if (tag === SPECIFIC_CHARACTER_SET) {
        own[tag] = 'ISO_IR 192';
      } else if (tag === MODALITIES_IN_STUDY) {
        const modalities = [...new Set(node.children.map((s) => s.attrs['00080060']).filter(Boolean))].sort();
        // substring match like the old code; differs from dimse: a list of
        // modalities ("CT\MR") matches any of them instead of nothing
        if (key && !key.split('\\').some((k) => modalities.some((m) => m.includes(k)))) {
          keep = false;
        }
        own[tag] = modalities.join('\\');
      } else if (tag === NUMBER_OF_STUDY_RELATED_SERIES || tag === NUMBER_OF_SERIES_RELATED_INSTANCES) {
        const count = String(node.children.length);
        if (key && key !== count) {
          keep = false;
        }
        own[tag] = count;
      } else {
        if (key && !matches(tag, key, node.attrs[tag])) {
          keep = false;
        }
        own[tag] = node.attrs[tag] || '';
      }
    });

    if (!keep) {
      return;
    }
    const collected = { ...inherited, ...own };
    if (levelIndex === depth) {
      results.push(collected);
      return;
    }
    node.children.forEach((child) => visit(child, levelIndex + 1, collected));
  };
  tree.forEach((patient) => visit(patient, 0, {}));

  return results.map((attrs) => {
    const rsp = {
      ...attrs,
      [QUERY_RETRIEVE_LEVEL]: queryLevel,
      [RETRIEVE_AE_TITLE]: retrieveAeTitle,
    };
    const json = {};
    [...request.keys()]
      .filter((tag) => rsp[tag] !== undefined)
      .sort()
      .forEach((tag) => {
        json[tag] = encode(tag, rsp[tag]);
      });
    return json;
  });
}

//------------------------------------------------------------------

// Caches the tree and rebuilds it when the storage folder changes. Imports add
// files to study folders, which bumps the folder mtime, so new studies show up
// without a restart.
function createIndex(storagePath, onError = () => {}) {
  let signature;
  let tree = [];

  const currentSignature = () => {
    if (!fs.existsSync(storagePath)) {
      return '';
    }
    const dirs = fs
      .readdirSync(storagePath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => `${d.name}:${fs.statSync(path.join(storagePath, d.name)).mtimeMs}`)
      .sort();
    return dirs.join('|');
  };

  return {
    query(queryLevel, tags, retrieveAeTitle) {
      const sig = currentSignature();
      if (sig !== signature) {
        tree = buildTree(listFiles(storagePath), onError);
        signature = sig;
      }
      return query(tree, queryLevel, tags, retrieveAeTitle);
    },
  };
}

module.exports = {
  isUid,
  createIndex,
  buildTree,
  listFiles,
  query,
  readAttributes,
  encode,
  matches,
};
