import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';

const _require = createRequire(import.meta.url);

// Get the REAL module objects (same references the source code uses)
const dimse = _require('dicom-dimse-native');
const utils = _require('../src/utils');

// Save originals so we can restore after each test
const origFindScu = dimse.findScu;
const origRecompress = dimse.recompress;

afterEach(() => {
  dimse.findScu = origFindScu;
  dimse.recompress = origRecompress;
});

// ─── findDicomName ──────────────────────────────────────────────────

describe('findDicomName', () => {
  it('should find tag by DICOM keyword', () => {
    expect(utils.findDicomName('PatientName')).toBe('00100010');
  });

  it('should find tag by hex code', () => {
    expect(utils.findDicomName('00100010')).toBe('00100010');
  });

  it('should find StudyInstanceUID', () => {
    expect(utils.findDicomName('StudyInstanceUID')).toBe('0020000D');
  });

  it('should return undefined for unknown name', () => {
    expect(utils.findDicomName('NonExistentTag')).toBeUndefined();
  });
});

// ─── findVR ─────────────────────────────────────────────────────────

describe('findVR', () => {
  it('should return VR for a known tag keyword', () => {
    expect(utils.findVR('PatientName')).toBe('PN');
  });

  it('should return VR for Modality', () => {
    expect(utils.findVR('Modality')).toBe('CS');
  });

  it('should return empty string for unknown tag', () => {
    expect(utils.findVR('NonExistentTag')).toBe('');
  });
});

// ─── Tag arrays ─────────────────────────────────────────────────────

describe('studyLevelTags', () => {
  it('should return an array of DICOM tag hex codes', () => {
    const tags = utils.studyLevelTags();
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags).toContain('0020000D'); // StudyInstanceUID
    expect(tags).toContain('00100010'); // PatientName
  });
});

describe('seriesLevelTags', () => {
  it('should return an array containing SeriesInstanceUID', () => {
    const tags = utils.seriesLevelTags();
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toContain('0020000E');
    expect(tags).toContain('00080060'); // Modality
  });
});

describe('imageLevelTags', () => {
  it('should return an array containing SOPInstanceUID', () => {
    const tags = utils.imageLevelTags();
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toContain('00080018');
    expect(tags).toContain('00200013'); // InstanceNumber
  });
});

describe('imageMetadataTags', () => {
  it('should return an array containing pixel data tags', () => {
    const tags = utils.imageMetadataTags();
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toContain('00280010'); // Rows
    expect(tags).toContain('00280011'); // Columns
    expect(tags).toContain('00280100'); // BitsAllocated
  });
});

// ─── fileExists ─────────────────────────────────────────────────────

describe('fileExists', () => {
  it('should resolve for existing file', async () => {
    const tmpFile = path.join(os.tmpdir(), `test-exists-${Date.now()}`);
    fs.writeFileSync(tmpFile, 'test');
    try {
      await expect(utils.fileExists(tmpFile)).resolves.toBeUndefined();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('should reject for non-existing file', async () => {
    await expect(
      utils.fileExists('/tmp/this-file-does-not-exist-' + Date.now()),
    ).rejects.toThrow();
  });
});

// ─── doFind ─────────────────────────────────────────────────────────

describe('doFind', () => {
  beforeEach(() => {
    dimse.findScu = vi.fn();
  });

  it('should return parsed results on success', async () => {
    const container = [
      { '00100010': { Value: ['Test Patient'], vr: 'PN' } },
    ];
    dimse.findScu.mockImplementation((_j, cb) => {
      cb(JSON.stringify({ code: 0, container: JSON.stringify(container) }));
    });

    const results = await utils.doFind('STUDY', {}, ['00100010']);
    expect(results).toEqual(container);
    expect(dimse.findScu).toHaveBeenCalledTimes(1);
  });

  it('should apply offset when provided', async () => {
    const container = [
      { '00100010': { Value: ['Patient A'], vr: 'PN' } },
      { '00100010': { Value: ['Patient B'], vr: 'PN' } },
      { '00100010': { Value: ['Patient C'], vr: 'PN' } },
    ];
    dimse.findScu.mockImplementation((_j, cb) => {
      cb(JSON.stringify({ code: 0, container: JSON.stringify(container) }));
    });

    const results = await utils.doFind('STUDY', { offset: '1' }, ['00100010']);
    expect(results).toHaveLength(2);
    expect(results[0]['00100010'].Value[0]).toBe('Patient B');
  });

  it('should return empty array on error code', async () => {
    dimse.findScu.mockImplementation((_j, cb) => {
      cb(JSON.stringify({ code: 2, message: 'error' }));
    });

    const results = await utils.doFind('STUDY', {}, ['00100010']);
    expect(results).toEqual([]);
  });

  it('should return empty array on invalid JSON', async () => {
    dimse.findScu.mockImplementation((_j, cb) => {
      cb('not valid json');
    });

    const results = await utils.doFind('STUDY', {}, ['00100010']);
    expect(results).toEqual([]);
  });

  it('should return empty array on empty result', async () => {
    dimse.findScu.mockImplementation((_j, cb) => {
      cb('');
    });

    const results = await utils.doFind('STUDY', {}, ['00100010']);
    expect(results).toEqual([]);
  });

  it('should include search params as DICOM tags', async () => {
    dimse.findScu.mockImplementation((j, cb) => {
      cb(JSON.stringify({ code: 0, container: '[]' }));
    });

    await utils.doFind('STUDY', { PatientName: 'Smith' }, ['00100010']);

    const call = dimse.findScu.mock.calls[0][0];
    const tagKeys = call.tags.map((t) => t.key);
    expect(tagKeys).toContain('00080052'); // query retrieve level
    expect(tagKeys).toContain('00100010'); // PatientName
  });

  it('should include includefield tags', async () => {
    dimse.findScu.mockImplementation((j, cb) => {
      cb(JSON.stringify({ code: 0, container: '[]' }));
    });

    await utils.doFind(
      'STUDY',
      { includefield: 'PatientBirthDate,PatientSex' },
      [],
    );

    const call = dimse.findScu.mock.calls[0][0];
    const tagKeys = call.tags.map((t) => t.key);
    expect(tagKeys).toContain('00100030'); // PatientBirthDate
    expect(tagKeys).toContain('00100040'); // PatientSex
  });
});

// ─── compressFile ───────────────────────────────────────────────────

describe('compressFile', () => {
  let tmpDir;

  beforeEach(() => {
    dimse.recompress = vi.fn();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return cached path if cache already exists', async () => {
    const ts = '1.2.840.10008.1.2';
    const tsSafe = ts.replace(/\./g, '_');
    const cacheDir = path.join(tmpDir, '.cache', tsSafe);
    fs.mkdirSync(cacheDir, { recursive: true });
    const inputFile = path.join(tmpDir, 'test.dcm');
    const cachedFile = path.join(cacheDir, 'test.dcm');
    fs.writeFileSync(inputFile, 'original');
    fs.writeFileSync(cachedFile, 'cached');

    const result = await utils.compressFile(inputFile, tmpDir, ts);
    expect(result).toBe(cachedFile);
    expect(dimse.recompress).not.toHaveBeenCalled();
  });

  it('should call recompress when cache miss', async () => {
    const ts = '1.2.840.10008.1.2';
    const inputFile = path.join(tmpDir, 'test.dcm');
    fs.writeFileSync(inputFile, 'original');

    dimse.recompress.mockImplementation((_j, cb) => {
      cb(JSON.stringify({ code: 0 }));
    });

    const result = await utils.compressFile(inputFile, tmpDir, ts);
    expect(dimse.recompress).toHaveBeenCalledTimes(1);
    expect(result).toContain('.cache');
    expect(result).toContain('test.dcm');
  });

  it('should reject when recompress fails', async () => {
    const ts = '1.2.840.10008.1.2';
    const inputFile = path.join(tmpDir, 'test.dcm');
    fs.writeFileSync(inputFile, 'original');

    dimse.recompress.mockImplementation((_j, cb) => {
      cb(JSON.stringify({ code: 1, message: 'compression error' }));
    });

    await expect(
      utils.compressFile(inputFile, tmpDir, ts),
    ).rejects.toThrow('compression error');
  });

  it('should reject on empty result', async () => {
    const ts = '1.2.840.10008.1.2';
    const inputFile = path.join(tmpDir, 'test.dcm');
    fs.writeFileSync(inputFile, 'original');

    dimse.recompress.mockImplementation((_j, cb) => {
      cb('');
    });

    await expect(
      utils.compressFile(inputFile, tmpDir, ts),
    ).rejects.toThrow('invalid result received');
  });
});
