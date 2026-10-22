const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildTree, listFiles, query, encode, matches, createIndex } = require('../src/dicomIndex');
const { storeInstance } = require('./helpers/dicom');
const { tempDir } = require('./helpers/server');

// two patients, three studies, four series, six instances
function instance(overrides) {
  return {
    '00080016': '1.2.840.10008.5.1.4.1.1.2',
    '00100010': 'DOE^JOHN',
    '00100020': 'P1',
    '00080020': '20240115',
    '00080030': '101500',
    '00080050': 'ACC1',
    '00081030': 'CT HEAD',
    '0020000D': '1.1',
    '0020000E': '1.1.1',
    '00080060': 'CT',
    '00200011': '1',
    '00200013': '1',
    '00280010': '512',
    '00280011': '512',
    '00280103': '0',
    '00281050': '40\\400',
    '00281051': '80\\1500',
    ...overrides,
  };
}

function fixture() {
  const storage = path.join(tempDir('index'), 'data');
  storeInstance(storage, instance({ '00080018': '1.1.1.1', '00200013': '2' }));
  storeInstance(storage, instance({ '00080018': '1.1.1.2', '00200013': '1' }));
  storeInstance(storage, instance({ '0020000E': '1.1.2', '00080060': 'SR', '00200011': '2', '00080018': '1.1.2.1' }));
  storeInstance(
    storage,
    instance({ '0020000D': '1.2', '00080020': '20240301', '00081030': 'MR KNEE', '0020000E': '1.2.1', '00080060': 'MR', '00080018': '1.2.1.1', '00080050': 'ACC2' }),
  );
  storeInstance(
    storage,
    instance({
      '00100010': 'SMITH^ANNA',
      '00100020': 'P2',
      '0020000D': '2.1',
      '00080020': '20231231',
      '00080050': 'X9',
      '00081030': '',
      '0020000E': '2.1.1',
      '00080018': '2.1.1.1',
      '00280103': '1',
    }),
  );
  storeInstance(
    storage,
    instance({ '00100010': 'SMITH^ANNA', '00100020': 'P2', '0020000D': '2.1', '0020000E': '2.1.1', '00080018': '2.1.1.2', '00200013': '2' }),
  );
  return storage;
}

const STUDY_RETURN_KEYS = ['00080005', '00080020', '00080050', '00080061', '00100010', '00100020', '0020000D', '00201206', '00201208'];

function find(storage, level, search = {}, returnKeys = STUDY_RETURN_KEYS) {
  const tags = [
    { key: '00080052', value: level },
    ...returnKeys.map((key) => ({ key, value: '' })),
    ...Object.entries(search).map(([key, value]) => ({ key, value })),
  ];
  return query(buildTree(listFiles(storage), () => {}), level, tags, 'DICOMWEB_PACS');
}

const uids = (results, tag = '0020000D') => results.map((r) => r[tag].Value[0]);

describe('query', () => {
  const storage = fixture();

  test('study level lists every study with computed attributes', () => {
    const studies = find(storage, 'STUDY');
    assert.deepEqual(uids(studies), ['1.1', '1.2', '2.1']);
    const first = studies[0];
    assert.deepEqual(first['00080061'], { Value: ['CT', 'SR'], vr: 'CS' });
    assert.deepEqual(first['00201206'], { Value: [2], vr: 'IS' });
    assert.deepEqual(first['00080005'], { Value: ['ISO_IR 192'], vr: 'CS' });
    assert.deepEqual(first['00080052'], { Value: ['STUDY'], vr: 'CS' });
    // not computed by the old backend either
    assert.deepEqual(first['00201208'], { vr: 'IS' });
    assert.deepEqual(first['00100010'], { Value: [{ Alphabetic: 'DOE^JOHN' }], vr: 'PN' });
  });

  test('keys are sorted and only requested keys are returned', () => {
    const [study] = find(storage, 'STUDY', {}, ['0020000D', '00100010']);
    assert.deepEqual(Object.keys(study), ['00080052', '00100010', '0020000D']);
  });

  test('keys below the query level and unsupported keys are dropped', () => {
    const [study] = find(storage, 'STUDY', {}, ['0020000D', '00080060', '00081190', '00080056']);
    assert.deepEqual(Object.keys(study), ['00080052', '0020000D']);
  });

  test('RetrieveAETitle is reported when requested', () => {
    const [study] = find(storage, 'STUDY', {}, ['0020000D', '00080054']);
    assert.deepEqual(study['00080054'], { Value: ['DICOMWEB_PACS'], vr: 'AE' });
  });

  test('wildcard matching is case-insensitive and anchored', () => {
    assert.deepEqual(uids(find(storage, 'STUDY', { '00100010': 'smith*' })), ['2.1']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00100010': 'DOE*' })), ['1.1', '1.2']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00100010': 'JOHN*' })), []);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00100010': 'D?E^JOHN' })), ['1.1', '1.2']);
  });

  test('exact matching is case-sensitive', () => {
    assert.deepEqual(uids(find(storage, 'STUDY', { '00100020': 'P2' })), ['2.1']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00100020': 'p2' })), []);
  });

  test('a space or caret switches to case-insensitive LIKE like the old SQL', () => {
    assert.deepEqual(uids(find(storage, 'STUDY', { '00100010': 'smith^anna' })), ['2.1']);
  });

  test('date ranges are inclusive and may be open', () => {
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080020': '20240101-20240131' })), ['1.1']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080020': '20240115-20240115' })), ['1.1']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080020': '20240116-20240301' })), ['1.2']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080020': '20240101-' })), ['1.1', '1.2']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080020': '-20231231' })), ['2.1']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080020': '20231231' })), ['2.1']);
  });

  test('UID lists match any listed UID', () => {
    assert.deepEqual(uids(find(storage, 'STUDY', { '0020000D': '1.2\\2.1' })), ['1.2', '2.1']);
  });

  test('ModalitiesInStudy filters on any series modality', () => {
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080061': 'SR' })), ['1.1']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080061': 'MR' })), ['1.2']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080061': 'MR\\SR' })), ['1.1', '1.2']);
    assert.deepEqual(uids(find(storage, 'STUDY', { '00080061': 'US' })), []);
  });

  test('series level is scoped to the study and counts instances', () => {
    const series = find(storage, 'SERIES', { '0020000D': '1.1' }, ['0020000E', '00080060', '00201209', '00201206']);
    assert.deepEqual(uids(series, '0020000E'), ['1.1.1', '1.1.2']);
    assert.deepEqual(
      series.map((s) => s['00201209'].Value[0]),
      [2, 1],
    );
    // study level attributes are available at lower levels
    assert.deepEqual(series[0]['00201206'], { Value: [2], vr: 'IS' });
  });

  test('image level is scoped to study and series', () => {
    const images = find(storage, 'IMAGE', { '0020000D': '1.1', '0020000E': '1.1.1' }, ['00080018', '00200013']);
    assert.deepEqual(uids(images, '00080018'), ['1.1.1.1', '1.1.1.2']);
    assert.deepEqual(find(storage, 'IMAGE', { '0020000D': '1.2', '0020000E': '1.1.1' }, ['00080018']), []);
  });

  test('image metadata values are typed like the old encoder', () => {
    const [image] = find(storage, 'IMAGE', { '00080018': '2.1.1.1' }, [
      '00280010', '00281050', '00281051', '00280103', '00200032', '00081030',
    ]);
    assert.deepEqual(image['00280010'], { Value: [512], vr: 'US' });
    assert.deepEqual(image['00281050'], { Value: [40, 400], vr: 'DS' });
    assert.deepEqual(image['00280103'], { Value: [1], vr: 'US' });
    // absent in the file
    assert.deepEqual(image['00200032'], { vr: 'DS' });
    // present but empty string
    assert.deepEqual(image['00081030'], { Value: [], vr: 'LO' });
  });

  test('a duplicate SOP instance is only indexed once', () => {
    const storageDup = fixture();
    storeInstance(storageDup, instance({ '0020000D': '9.9', '0020000E': '9.9.1', '00080018': '1.1.1.1' }));
    // 9.9 sorts after 1.1, so the first copy wins and no study 9.9 appears
    assert.deepEqual(uids(find(storageDup, 'STUDY')), ['1.1', '1.2', '2.1']);
  });

  test('unreadable files are reported and skipped', () => {
    const storageBad = fixture();
    fs.writeFileSync(path.join(storageBad, '1.1', 'garbage'), 'not dicom');
    const errors = [];
    const tree = buildTree(listFiles(storageBad), (file) => errors.push(path.basename(file)));
    assert.deepEqual(errors, ['garbage']);
    assert.equal(query(tree, 'STUDY', [{ key: '0020000D', value: '' }], 'X').length, 3);
  });

  test('hidden folders such as .cache and the old image.db are ignored', () => {
    const storageExtra = fixture();
    fs.writeFileSync(path.join(storageExtra, 'image.db'), 'sqlite');
    fs.mkdirSync(path.join(storageExtra, '1.1', '.cache', 'ts'), { recursive: true });
    fs.copyFileSync(path.join(storageExtra, '1.1', '1.1.1.1'), path.join(storageExtra, '1.1', '.cache', 'ts', 'copy'));
    const errors = [];
    buildTree(listFiles(storageExtra), (file) => errors.push(file));
    assert.deepEqual(errors, []);
    assert.equal(listFiles(storageExtra).length, 6);
  });

  test('createIndex picks up newly imported instances without a restart', async () => {
    const storageLive = fixture();
    const index = createIndex(storageLive);
    const tags = [{ key: '0020000D', value: '' }];
    assert.equal(index.query('STUDY', tags, 'X').length, 3);

    storeInstance(storageLive, instance({ '0020000D': '3.1', '0020000E': '3.1.1', '00080018': '3.1.1.1' }));
    assert.equal(index.query('STUDY', tags, 'X').length, 4);

    // a new instance in an existing study changes that study's folder
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    storeInstance(storageLive, instance({ '0020000D': '3.1', '0020000E': '3.1.2', '00080018': '3.1.2.1' }));
    const series = index.query('SERIES', [{ key: '0020000D', value: '3.1' }, { key: '0020000E', value: '' }], 'X');
    assert.equal(series.length, 2);
  });

  test('a missing storage folder gives no results instead of an error', () => {
    const index = createIndex(path.join(tempDir('none'), 'missing'));
    assert.deepEqual(index.query('STUDY', [{ key: '0020000D', value: '' }], 'X'), []);
  });
});

describe('encode', () => {
  test('PN is always wrapped, even when empty', () => {
    assert.deepEqual(encode('00100010', ''), { Value: [{ Alphabetic: '' }], vr: 'PN' });
  });
  test('integers parse like stoi', () => {
    assert.deepEqual(encode('00200013', '12'), { Value: [12], vr: 'IS' });
    assert.deepEqual(encode('00200013', ' 7 '), { Value: [7], vr: 'IS' });
    assert.deepEqual(encode('00200013', 'x'), { vr: 'IS' });
    assert.deepEqual(encode('00200013', ''), { vr: 'IS' });
  });
  test('decimals keep the float precision of stof', () => {
    assert.deepEqual(encode('00281053', '0.1'), { Value: [Math.fround(0.1)], vr: 'DS' });
    assert.deepEqual(encode('00280030', '0.5\\0.25'), { Value: [0.5, 0.25], vr: 'DS' });
  });
  test('strings split on backslash without a trailing empty value', () => {
    assert.deepEqual(encode('00080008', 'ORIGINAL\\PRIMARY\\'), { Value: ['ORIGINAL', 'PRIMARY'], vr: 'CS' });
    assert.deepEqual(encode('00081030', ''), { Value: [], vr: 'LO' });
  });
});

describe('matches', () => {
  test('only the first * and ? are wildcards, like the old replace()', () => {
    assert.equal(matches('00100010', 'A*', 'ABC'), true);
    assert.equal(matches('00100010', 'A*C*', 'ABC'), false);
    assert.equal(matches('00100010', 'A*C*', 'ABC*'), true);
  });
  test('% and _ in a wildcard search behave like SQL LIKE', () => {
    assert.equal(matches('00100010', 'A%C*', 'ABC'), true);
    assert.equal(matches('00100010', 'A_C*', 'ABC'), true);
  });
  test('regex characters are literal', () => {
    assert.equal(matches('00100010', 'A.C*', 'ABC'), false);
    assert.equal(matches('00100010', 'A.C*', 'A.C'), true);
  });
});
