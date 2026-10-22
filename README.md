# dicomweb-pacs

An easy to use PACS with DICOMWEB support

## Description
* A nodejs tool to easily spawn a PACS server including DICOM viewer connected via DICOMWEB (QIDO-RS and WADO-RS).
* Comes preinstalled with the popular [OHIF DICOM Web Viewer](https://github.com/OHIF/Viewers) (version 3.10.1).
* Supports OHIF MPR (vtk.js) feature for viewing volumetric datasets
* multithreaded
* no database: QIDO is answered from an index of the storage folder

No need for a server, try the [standalone desktop edition](https://github.com/knopkem/pacsnode).

## Prerequisite

* nodejs 20 or newer (for running from source)
* Docker and Docker Compose (for containerized deployment)

## Setup Instructions - Docker (recommended)

* clone repository:
  ```
  git clone https://github.com/knopkem/dicomweb-pacs.git
  cd dicomweb-pacs
  ```

* start with Docker Compose:
  ```
  docker compose up -d
  ```

* this will build the image and start the server with:
  * OHIF viewer on `http://localhost:5001`
  * import with `docker compose exec dicomweb-pacs npm run import`
  * persistent volumes for `data/`, `logs/`, and `import/`

* stop the server:
  ```
  docker compose down
  ```

* rebuild after changes:
  ```
  docker compose up -d --build
  ```

## Setup Instructions - npm

* install in empty directory:  
  ```npm init -y```  
  ```npm install dicomweb-pacs```

* update config file located in:  
  ```./node_modules/dicomweb-pacs/config```

* start pacs:  
  ```npx dicomweb-pacs```

## Setup Instructions - source

* clone repository and install dependencies
  ```npm install```

* update config file located in:
  ```./config```

* run:
  ```npm start```

* import DICOM images: put DICOM files into the import directory and run  
  ```npm run import``` (or ```npm run import -- <folder>```)  
  Files are copied to the storage path as `<StudyInstanceUID>/<SOPInstanceUID>`;
  the server does not need to be running and picks new studies up on the next query.
  There is no DIMSE (C-STORE/C-FIND) server: QIDO is answered from an index of the storage folder.

* run the tests  
  ```npm test```

* open webbrowser and start viewing  
  ```http://localhost:5001```

## What to modify

* (optional) change our port or AET 

  ```
    config.source = {
      aet: "OUR_AET",
      ip: "OUR_IP",
      port: "OUR_PORT"
    };
    ```

* add peers to your PACS

  ```
    config.peers = [
    {
      aet: "PEER_AET",
      ip: "PEER_IP",
      port: "PEER_PORT"
    }];
    ```

* update webserver port:  
  ```config.webserverPort = 5001;```

## Security

* DICOM UID parameters are validated (digits and dots only, max 64 characters) to prevent path traversal attacks
* File paths are resolved and checked against the storage directory before access
* Error responses return generic messages without leaking filesystem paths or internal details

## License
MIT
