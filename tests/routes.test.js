import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Fastify from 'fastify';

const _require = createRequire(import.meta.url);

// Get the REAL utils object (same reference routes.js uses via require('../utils'))
const utils = _require('../src/utils');

// Import route helpers for direct unit testing
const { applyDefault, sortByInstanceNumber, fixResponse, isValidUid } = _require('../src/routes/routes');

// Save originals
const origDoFind = utils.doFind;
const origFileExists = utils.fileExists;
const origCompressFile = utils.compressFile;

afterEach(() => {
  utils.doFind = origDoFind;
  utils.fileExists = origFileExists;
  utils.compressFile = origCompressFile;
});

// ─── applyDefault ───────────────────────────────────────────────────

describe('applyDefault', () => {
  it('should add default value when tag is missing', () => {
    const json = {};
    const result = applyDefault(json, '00281050', 'DS', '100.0');
    expect(result['00281050']).toEqual({ Value: ['100.0'], vr: 'DS' });
  });

  it('should not overwrite existing value', () => {
    const json = {
      '00281050': { Value: ['200.0'], vr: 'DS' },
    };
    const result = applyDefault(json, '00281050', 'DS', '100.0');
    expect(result['00281050'].Value[0]).toBe('200.0');
  });

  it('should add default when Value is null', () => {
    const json = { '00281050': { Value: null, vr: 'DS' } };
    const result = applyDefault(json, '00281050', 'DS', '100.0');
    expect(result['00281050'].Value).toEqual(['100.0']);
  });
});

// ─── sortByInstanceNumber ───────────────────────────────────────────

describe('sortByInstanceNumber', () => {
  it('should sort by InstanceNumber tag (00200013)', () => {
    const results = [
      { '00200013': { Value: ['3'] } },
      { '00200013': { Value: ['1'] } },
      { '00200013': { Value: ['2'] } },
    ];
    const sorted = sortByInstanceNumber(results);
    expect(sorted[0]['00200013'].Value[0]).toBe('1');
    expect(sorted[1]['00200013'].Value[0]).toBe('2');
    expect(sorted[2]['00200013'].Value[0]).toBe('3');
  });

  it('should handle missing InstanceNumber (defaults to 0)', () => {
    const results = [
      { '00200013': { Value: ['2'] } },
      { '00080018': { Value: ['1.2.3'] } },
    ];
    const sorted = sortByInstanceNumber(results);
    expect(sorted[0]['00080018']).toBeDefined();
    expect(sorted[1]['00200013'].Value[0]).toBe('2');
  });

  it('should handle empty array', () => {
    expect(sortByInstanceNumber([])).toEqual([]);
  });
});

// ─── fixResponse ────────────────────────────────────────────────────

describe('fixResponse', () => {
  it('should apply window center/width and rescale defaults', () => {
    const json = [{}];
    const result = fixResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0]['00281050']).toEqual({ Value: ['100.0'], vr: 'DS' });
    expect(result[0]['00281051']).toEqual({ Value: ['100.0'], vr: 'DS' });
    expect(result[0]['00281052']).toEqual({ Value: ['1.0'], vr: 'DS' });
    expect(result[0]['00281053']).toEqual({ Value: ['1.0'], vr: 'DS' });
  });

  it('should not overwrite existing values', () => {
    const json = [
      {
        '00281050': { Value: ['500.0'], vr: 'DS' },
        '00281051': { Value: ['800.0'], vr: 'DS' },
      },
    ];
    const result = fixResponse(json);
    expect(result[0]['00281050'].Value[0]).toBe('500.0');
    expect(result[0]['00281051'].Value[0]).toBe('800.0');
    expect(result[0]['00281052'].Value[0]).toBe('1.0');
    expect(result[0]['00281053'].Value[0]).toBe('1.0');
  });
});

// ─── Route integration tests ────────────────────────────────────────

describe('routes', () => {
  let app;

  beforeEach(async () => {
    // Replace utils methods with mocks (same object routes.js references)
    utils.doFind = vi.fn().mockResolvedValue([]);
    utils.fileExists = vi.fn().mockRejectedValue(new Error('not found'));
    utils.compressFile = vi.fn().mockResolvedValue('/tmp/cached.dcm');

    app = Fastify();
    const routesPlugin = _require('../src/routes/routes');
    app.register(routesPlugin);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // --- GET /rs/studies ---

  describe('GET /rs/studies', () => {
    it('should return studies from doFind', async () => {
      const studies = [
        {
          '0020000D': { Value: ['1.2.3.4'], vr: 'UI' },
          '00100010': { Value: ['Doe^John'], vr: 'PN' },
        },
      ];
      utils.doFind.mockResolvedValue(studies);

      const response = await app.inject({
        method: 'GET',
        url: '/rs/studies',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(
        'application/dicom+json',
      );
      expect(JSON.parse(response.body)).toEqual(studies);
    });

    it('should pass query params to doFind', async () => {
      await app.inject({
        method: 'GET',
        url: '/rs/studies?PatientName=Smith',
      });

      expect(utils.doFind).toHaveBeenCalledWith(
        'STUDY',
        expect.objectContaining({ PatientName: 'Smith' }),
        expect.any(Array),
      );
    });
  });

  // --- GET /rs/studies/:uid/series ---

  describe('GET /rs/studies/:uid/series', () => {
    it('should query series for a study', async () => {
      const series = [
        {
          '0020000E': { Value: ['1.2.3.4.5'], vr: 'UI' },
          '00080060': { Value: ['CT'], vr: 'CS' },
        },
      ];
      utils.doFind.mockResolvedValue(series);

      const response = await app.inject({
        method: 'GET',
        url: '/rs/studies/1.2.3.4/series',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(series);
      expect(utils.doFind).toHaveBeenCalledWith(
        'SERIES',
        expect.objectContaining({ StudyInstanceUID: '1.2.3.4' }),
        expect.any(Array),
      );
    });
  });

  // --- GET /rs/studies/:uid/series/:uid/instances ---

  describe('GET /rs/studies/:uid/series/:uid/instances', () => {
    it('should return instances sorted by InstanceNumber', async () => {
      const instances = [
        {
          '00080018': { Value: ['1.2.3'], vr: 'UI' },
          '00200013': { Value: ['3'] },
        },
        {
          '00080018': { Value: ['1.2.4'], vr: 'UI' },
          '00200013': { Value: ['1'] },
        },
      ];
      utils.doFind.mockResolvedValue(instances);

      const response = await app.inject({
        method: 'GET',
        url: '/rs/studies/1.2.3/series/1.2.4/instances',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body[0]['00200013'].Value[0]).toBe('1');
      expect(body[1]['00200013'].Value[0]).toBe('3');
    });
  });

  // --- GET /rs/studies/:uid/series/:uid/metadata ---

  describe('GET /rs/studies/:uid/series/:uid/metadata', () => {
    it('should return metadata with defaults applied', async () => {
      const metadata = [
        {
          '00080018': { Value: ['1.2.3'], vr: 'UI' },
          '00200013': { Value: ['1'] },
        },
      ];
      utils.doFind.mockResolvedValue(metadata);

      const response = await app.inject({
        method: 'GET',
        url: '/rs/studies/1.2.3/series/1.2.4/metadata',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body[0]['00281050']).toBeDefined();
      expect(body[0]['00281051']).toBeDefined();
    });
  });

  // --- GET /rs/studies/:uid/metadata ---

  describe('GET /rs/studies/:uid/metadata', () => {
    it('should query SERIES level with study and series tags', async () => {
      await app.inject({
        method: 'GET',
        url: '/rs/studies/1.2.3/metadata',
      });

      expect(utils.doFind).toHaveBeenCalledWith(
        'SERIES',
        expect.objectContaining({ StudyInstanceUID: '1.2.3' }),
        expect.any(Array),
      );
    });
  });

  // --- GET /wadouri ---

  describe('GET /wadouri', () => {
    it('should return 400 when parameters are missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wadouri',
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('missing parameters');
    });

    it('should return 400 when studyUID is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wadouri?seriesUID=1.2&objectUID=1.3',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 when file not found', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wadouri?studyUID=1.2&seriesUID=1.3&objectUID=1.4',
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('File not found');
    });
  });

  // --- GET frames ---

  describe('GET frames endpoint', () => {
    it('should return 404 when file does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/rs/studies/1.2/series/1.3/instances/1.4/frames/1',
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('File not found');
    });
  });

  // --- UID validation & path traversal ---

  describe('UID validation', () => {
    it('should return 400 for path traversal in frames endpoint', async () => {
      // URL-encode slashes so Fastify routes it to the handler instead of normalizing the path
      const response = await app.inject({
        method: 'GET',
        url: '/rs/studies/..%2F..%2Fetc/series/1.3/instances/passwd/frames/1',
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('Invalid UID format');
    });

    it('should return 400 for path traversal in wadouri endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wadouri?studyUID=../../etc&seriesUID=1.2&objectUID=passwd',
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('Invalid UID format');
    });

    it('should return 400 for UIDs with letters in frames endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/rs/studies/abc123/series/1.3/instances/1.4/frames/1',
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('Invalid UID format');
    });

    it('should return 400 for UIDs with letters in wadouri endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/wadouri?studyUID=abc&seriesUID=1.2&objectUID=1.3',
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('Invalid UID format');
    });
  });
});

// ─── isValidUid unit tests ───────────────────────────────────────────

describe('isValidUid', () => {
  it('should accept valid DICOM UIDs', () => {
    expect(isValidUid('1.2.840.10008.1.2')).toBe(true);
    expect(isValidUid('1.2.3')).toBe(true);
    expect(isValidUid('123')).toBe(true);
  });

  it('should reject UIDs with letters', () => {
    expect(isValidUid('abc')).toBe(false);
    expect(isValidUid('1.2.abc.3')).toBe(false);
  });

  it('should reject UIDs with path traversal characters', () => {
    expect(isValidUid('../../etc')).toBe(false);
    expect(isValidUid('../passwd')).toBe(false);
    expect(isValidUid('1.2/3.4')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidUid('')).toBe(false);
  });

  it('should reject UIDs longer than 64 characters', () => {
    const longUid = '1.' + '2'.repeat(63);
    expect(isValidUid(longUid)).toBe(false);
  });

  it('should reject non-string values', () => {
    expect(isValidUid(undefined)).toBe(false);
    expect(isValidUid(null)).toBe(false);
    expect(isValidUid(123)).toBe(false);
  });
});
