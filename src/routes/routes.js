const fs = require('fs');
const path = require('path');
const dicomParser = require('dicom-parser');
const crypto = require('crypto');
const { Readable } = require('stream');
const config = require('config');
const utils = require('../utils');

const logger = utils.getLogger();

function isValidUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 64 && /^[\d.]+$/.test(uid);
}

function safePath(storagePath, ...segments) {
  const resolved = path.resolve(path.join(storagePath, ...segments));
  const resolvedStorage = path.resolve(storagePath);
  if (!resolved.startsWith(resolvedStorage + path.sep) && resolved !== resolvedStorage) {
    return null;
  }
  return resolved;
}

function applyDefault(json, tag, vr, defaultValue) {
  const rsp = json;
  if (!rsp[tag]?.Value) {
    rsp[tag] = {
      Value: [defaultValue],
      vr,
    };
  }
  return rsp;
}

function sortByInstanceNumber(results) {
  return results.sort((a, b) => {
    const aNum = parseInt(a['00200013']?.Value?.[0] || '0', 10);
    const bNum = parseInt(b['00200013']?.Value?.[0] || '0', 10);
    return aNum - bNum;
  });
}

// just make sure these have some sane defaults (while actually these are depending on the type and the viewer should cope with it, but OHIF doesn't)
function fixResponse(json) {
  const rspArray = [];
  json.forEach(element => {
    let rsp = element;
    rsp = applyDefault(rsp, '00281050', 'DS', '100.0');
    rsp = applyDefault(rsp, '00281051', 'DS', '100.0');
    rsp = applyDefault(rsp, '00281052', 'DS', '1.0');
    rsp = applyDefault(rsp, '00281053', 'DS', '1.0');
    rspArray.push(rsp);
  });
  return rspArray;
}

function routes(server, opts, done) {
  //------------------------------------------------------------------

  server.get('/rs/studies', async (req, reply) => {
    const tags = utils.studyLevelTags();
    const json = await utils.doFind('STUDY', req.query, tags);
    reply.header('Content-Type', 'application/dicom+json');
    return json;
  });

  //------------------------------------------------------------------

  server.get('/rs/studies/:studyInstanceUid/metadata', async (req, reply) => {
    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;
    const stTags = utils.studyLevelTags();
    const serTags = utils.seriesLevelTags();
    const json = await utils.doFind('SERIES', query, [...stTags, ...serTags]);
    reply.header('Content-Type', 'application/dicom+json');
    return json;
  });

  //------------------------------------------------------------------

  server.get('/rs/studies/:studyInstanceUid/series', async (req, reply) => {
    const tags = utils.seriesLevelTags();
    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;

    const json = await utils.doFind('SERIES', query, tags);
    reply.header('Content-Type', 'application/dicom+json');
    return json;
  });

  //------------------------------------------------------------------

  server.get('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances', async (req, reply) => {
    const tags = utils.imageLevelTags();
    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;
    query.SeriesInstanceUID = req.params.seriesInstanceUid;

    const json = await utils.doFind('IMAGE', query, tags);
    reply.header('Content-Type', 'application/dicom+json');
    return sortByInstanceNumber(json);
  });

  //------------------------------------------------------------------

  server.get('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/metadata', async (req, reply) => {
    const stTags = utils.studyLevelTags();
    const serTags = utils.seriesLevelTags();
    const imTags = utils.imageMetadataTags();
    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;
    query.SeriesInstanceUID = req.params.seriesInstanceUid;

    const json = await utils.doFind('IMAGE', query, [...stTags, ...serTags, ...imTags]);
    reply.header('Content-Type', 'application/dicom+json');
    return sortByInstanceNumber(fixResponse(json));
  });

  //------------------------------------------------------------------

  server.get('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/metadata', async (req, reply) => {
    const stTags = utils.studyLevelTags();
    const serTags = utils.seriesLevelTags();
    const imTags = utils.imageMetadataTags();
    const { query } = req;
    query.StudyInstanceUID = req.params.studyInstanceUid;
    query.SeriesInstanceUID = req.params.seriesInstanceUid;
    query.SOPInstanceUID = req.params.sopInstanceUid;

    const json = await utils.doFind('IMAGE', query, [...stTags, ...serTags, ...imTags]);
    reply.header('Content-Type', 'application/dicom+json');
    return fixResponse(json);
  });

  //------------------------------------------------------------------

  server.get('/rs/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/frames/:frame', async (req, reply) => {
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;

    if (!isValidUid(studyInstanceUid) || !isValidUid(seriesInstanceUid) || !isValidUid(sopInstanceUid)) {
      reply.code(400);
      return 'Invalid UID format';
    }

    const storagePath = config.get('storagePath');
    const pathname = safePath(storagePath, studyInstanceUid, sopInstanceUid);
    if (!pathname) {
      reply.code(400);
      return 'Invalid path';
    }
    const studyPath = path.dirname(pathname);

    let contentLocation = `/studies/${studyInstanceUid}`;
    if (seriesInstanceUid) {
      contentLocation += `/series/${seriesInstanceUid}`;
    }
    if (sopInstanceUid) {
      contentLocation += `/instance/${sopInstanceUid}`;
    }

    try {
      // logger.info(studyInstanceUid, seriesInstanceUid, sopInstanceUid, frame);
      await utils.fileExists(pathname);
    } catch (error) {
      logger.error(error);
      reply.code(404);
      return 'File not found';
    }

    let cachedPath;
    try {
      cachedPath = await utils.compressFile(pathname, studyPath, '1.2.840.10008.1.2'); // for now default to uncompressed
    } catch (error) {
      logger.error(error);
      reply.code(500);
      return 'Failed to process file';
    }

    // read file from cache
    try {
      const data = await fs.promises.readFile(cachedPath);
      const dataset = dicomParser.parseDicom(data);
      const pixelDataElement = dataset.elements.x7fe00010;
      const buffer = Buffer.from(dataset.byteArray.buffer, pixelDataElement.dataOffset, pixelDataElement.length);

      const term = '\r\n';
      const boundary = crypto.randomBytes(16).toString('hex');
      const endline = `${term}--${boundary}--${term}`;

      reply.header('Content-Type', `multipart/related;type='application/octed-stream';boundary='${boundary}'`);

      const readStream = new Readable({
        read() {
          this.push(`${term}--${boundary}${term}`);
          this.push(`Content-Location:${contentLocation};${term}`);
          this.push(`Content-Type:application/octet-stream;${term}`);
          this.push(term);
          this.push(buffer);
          this.push(endline);
          this.push(null);
        },
      });
      return readStream;
    } catch (error) {
      logger.error(error);
      reply.code(500);
      return 'Error reading file';
    }
  });

  //------------------------------------------------------------------

  server.get('/wadouri', async (req, reply) => {
    const studyUid = req.query.studyUID;
    const seriesUid = req.query.seriesUID;
    const imageUid = req.query.objectUID;
    if (!studyUid || !seriesUid || !imageUid) {
      const msg = `Error missing parameters.`;
      logger.error(msg);
      reply.code(400);
      return msg;
    }

    if (!isValidUid(studyUid) || !isValidUid(seriesUid) || !isValidUid(imageUid)) {
      reply.code(400);
      return 'Invalid UID format';
    }

    const storagePath = config.get('storagePath');
    const pathname = safePath(storagePath, studyUid, imageUid);
    if (!pathname) {
      reply.code(400);
      return 'Invalid path';
    }
    const studyPath = path.dirname(pathname);

    try {
      await utils.fileExists(pathname);
    } catch (error) {
      logger.error(error);
      reply.code(404);
      return 'File not found';
    }

    let cachedPath;
    try {
      cachedPath = await utils.compressFile(pathname, studyPath);
    } catch (error) {
      logger.error(error);
      reply.code(500);
      return 'Failed to process file';
    }

    // read file from cache
    try {
      const data = await fs.promises.readFile(cachedPath);
      reply.header('Content-Type', 'application/dicom+json');
      return data;
    } catch (error) {
      logger.error(error);
      reply.code(500);
      return 'Error reading file';
    }
  });
  done();
}

module.exports = routes;
module.exports.applyDefault = applyDefault;
module.exports.sortByInstanceNumber = sortByInstanceNumber;
module.exports.fixResponse = fixResponse;
module.exports.isValidUid = isValidUid;
