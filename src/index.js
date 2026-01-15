import express from 'express';
import WebTorrent from 'webtorrent';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuração Dinâmica para o Render (process.env.PORT)
const CONFIG = {
  DOWNLOAD_ROOT: 'downloads',
  PORT: process.env.PORT || 8080,
  METADATA_TIMEOUT: 40000, 
  CLEANUP_GRACE_PERIOD: 5000, 
};

const __filename = fileURLToPath(import.meta.url);
const app = express();

app.use(cors());

if (!fs.existsSync(CONFIG.DOWNLOAD_ROOT)) {
  fs.mkdirSync(CONFIG.DOWNLOAD_ROOT);
}

class StreamSession {
  constructor(magnet) {
    this.magnet = magnet;
    this.infoHash = null;
    this.client = new WebTorrent({ maxConns: 100 });
    this.folderPath = path.join(CONFIG.DOWNLOAD_ROOT, Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9));
    this.files = []; 
    this.ready = false;
    this.viewers = 0;
    this.cleanupTimer = null;
    this.isDestroyed = false;
    
    this.client.on('error', (err) => console.error(`🔥 [SESSION ERROR]`, err.message));
  }

  initialize() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.ready) {
          this.destroy();
          reject(new Error('TIMEOUT: Metadados não encontrados.'));
        }
      }, CONFIG.METADATA_TIMEOUT);

      try {
        this.client.add(this.magnet, { path: this.folderPath }, (torrent) => {
          clearTimeout(timeout);
          this.infoHash = torrent.infoHash;
          this.files = torrent.files.filter(f => f.name.match(/\.(mp4|mkv|avi|webm|mov)$/i));
          this.ready = true;
          console.log(`🚀 [READY] Torrent carregado. ${this.files.length} vídeos.`);
          resolve(this);
        });
      } catch (err) {
        clearTimeout(timeout);
        this.destroy();
        reject(err);
      }
    });
  }

  selectFile(season, episode) {
    if (!this.files || this.files.length === 0) return null;

    if (!season || !episode || season === 'undefined') {
      return this.files.reduce((a, b) => (a.length > b.length ? a : b));
    }

    const s = parseInt(season);
    const e = parseInt(episode);
    console.log(`🔎 [SMART SELECT] Buscando S${s}E${e}...`);

    // 1. REGEX EXATO
    const exactRegex = new RegExp(`(S0?${s}.*E0?${e}(?![0-9]))|(\\b${s}x0?${e}(?![0-9]))`, 'i');
    let target = this.files.find(f => f.name.match(exactRegex));

    if (target) {
      console.log(`✅ [MATCH] Arquivo: ${target.name}`);
      return target;
    }

    // 2. FALLBACK POR ÍNDICE
    if (this.files.length > 1) {
      const sortedFiles = [...this.files].sort((a, b) => 
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
      
      const index = e - 1;
      const candidate = sortedFiles[index];

      if (candidate) {
        // Validação: Se o candidato diz ser OUTRO episódio, rejeita.
        const wrongEpRegex = /(?:E|Episode)[ ._-]*(\d+)(?![0-9])/i;
        const match = candidate.name.match(wrongEpRegex);
        
        if (match && parseInt(match[1]) !== e) {
           console.warn(`❌ [REJECTED] Fallback é Ep ${match[1]}, queríamos ${e}.`);
           return null;
        }
        return candidate;
      }
    }

    // 3. ARQUIVO ÚNICO (Com Trava de Segurança)
    if (this.files.length === 1) {
       const f = this.files[0];
       const epCheckRegex = /(?:S\d+[ ._-]*E|x|Episode[ ._-]*)(\d+)(?![0-9])/i;
       const match = f.name.match(epCheckRegex);
       
       if (match) {
         const fileEp = parseInt(match[1]);
         if (fileEp !== e) {
            console.error(`❌ [MISMATCH] Arquivo único é Ep ${fileEp}, solicitado ${e}. Abortando.`);
            return null; 
         }
       }
       return f;
    }

    return null;
  }

  addViewer() {
    if (this.isDestroyed) return;
    this.viewers++;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  removeViewer() {
    if (this.isDestroyed) return;
    this.viewers--;
    if (this.viewers <= 0) {
      this.viewers = 0;
      if (!this.cleanupTimer) {
        this.cleanupTimer = setTimeout(() => this.destroy(), CONFIG.CLEANUP_GRACE_PERIOD);
      }
    }
  }

  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    console.log(`💥 [DESTROY] Limpando sessão...`);
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    if (this.infoHash && activeSessions.has(this.infoHash)) activeSessions.delete(this.infoHash);

    try {
      if (this.client && !this.client.destroyed) {
        this.client.destroy(() => this.deleteFiles());
      } else {
        this.deleteFiles();
      }
    } catch (e) { this.deleteFiles(); }
  }

  deleteFiles() {
    if (fs.existsSync(this.folderPath)) {
      fs.rm(this.folderPath, { recursive: true, force: true }, () => {});
    }
  }
}

const activeSessions = new Map();

app.get('/', (req, res) => res.send('Smart Stream Engine: ON'));

app.get('/stream', async (req, res) => {
  const { magnet, season, episode } = req.query; 
  
  if (!magnet) return res.status(400).json({ error: 'Magnet Link obrigatório' });

  let session;
  for (let s of activeSessions.values()) {
    if (s.magnet === magnet && !s.isDestroyed) {
      session = s;
      break;
    }
  }

  try {
    if (!session) {
      session = new StreamSession(magnet);
      await session.initialize();
      activeSessions.set(session.infoHash, session);
    }

    session.addViewer();

    const file = session.selectFile(season, episode);
    
    if (!file) {
        session.removeViewer();
        throw new Error("Episódio correto não encontrado neste torrent.");
    }

    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        'Content-Length': file.length,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes'
      });
      const stream = file.createReadStream();
      handleStreamEvents(stream, req, session);
      stream.pipe(res);
    } else {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });

      const stream = file.createReadStream({ start, end });
      handleStreamEvents(stream, req, session);
      stream.pipe(res);
    }

  } catch (error) {
    console.error("❌ [STREAM FAIL]", error.message);
    return res.status(504).json({ error: 'Falha ao processar arquivo.', details: error.message });
  }
});

function handleStreamEvents(stream, req, session) {
  let closed = false;
  const closeStream = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
    session.removeViewer();
  };
  req.on('close', closeStream);
  stream.on('error', (err) => {
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') closeStream();
  });
}

process.on('uncaughtException', (err) => {});
app.listen(CONFIG.PORT, () => console.log(`🚀 Smart Engine Rodando na porta ${CONFIG.PORT}`));