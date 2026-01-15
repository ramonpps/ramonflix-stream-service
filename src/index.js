import express from 'express';
import WebTorrent from 'webtorrent';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Se você não instalou o rimraf, pode manter usando o fs.rm nativo como abaixo
// import { rimraf } from 'rimraf'; 

// === CONFIGURAÇÕES ===
const CONFIG = {
  DOWNLOAD_ROOT: 'downloads',
  PORT: 8080,
  METADATA_TIMEOUT: 20000, // Aumentei um pouco para garantir em conexões lentas
  CLEANUP_GRACE_PERIOD: 5000, 
};

const __filename = fileURLToPath(import.meta.url);
const app = express();

app.use(cors());

// Garante pasta de downloads
if (!fs.existsSync(CONFIG.DOWNLOAD_ROOT)) {
  fs.mkdirSync(CONFIG.DOWNLOAD_ROOT);
}

class StreamSession {
  constructor(magnet) {
    this.magnet = magnet;
    this.infoHash = null;
    this.client = new WebTorrent({ maxConns: 100 });
    this.folderPath = path.join(CONFIG.DOWNLOAD_ROOT, Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9));
    this.file = null;
    this.ready = false;
    this.viewers = 0;
    this.cleanupTimer = null;
    this.isDestroyed = false; // TRAVA DE SEGURANÇA 1
    
    this.client.on('error', (err) => {
      console.error(`🔥 [SESSION ERROR] ${this.infoHash}:`, err.message);
    });
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
          this.ready = true;
          
          this.file = torrent.files.find(f => f.name.match(/\.(mp4|mkv|avi|webm)$/i));
          if (!this.file) {
             this.file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
          }

          console.log(`🚀 [READY] Torrent pronto: ${this.file.name}`);
          resolve(this);
        });
      } catch (err) {
        clearTimeout(timeout);
        this.destroy();
        reject(err);
      }
    });
  }

  addViewer() {
    if (this.isDestroyed) return;
    this.viewers++;
    if (this.cleanupTimer) {
      console.log(`bust [KEEP ALIVE] Usuário voltou. Cancelando exclusão.`);
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  removeViewer() {
    if (this.isDestroyed) return;
    this.viewers--;
    if (this.viewers <= 0) {
      this.viewers = 0;
      // Evita agendar duplicado
      if (!this.cleanupTimer) {
        console.log(`⏳ [GRACE PERIOD] Deletando em ${CONFIG.CLEANUP_GRACE_PERIOD}ms...`);
        this.cleanupTimer = setTimeout(() => {
          this.destroy();
        }, CONFIG.CLEANUP_GRACE_PERIOD);
      }
    }
  }

  destroy() {
    // TRAVA DE SEGURANÇA 2: Impede dupla destruição
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    console.log(`💥 [DESTROY] Limpando sessão ${this.infoHash || 'n/a'}...`);
    
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);

    if (this.infoHash && activeSessions.has(this.infoHash)) {
      activeSessions.delete(this.infoHash);
    }

    try {
      // Verifica se o cliente já não morreu por outro motivo
      if (this.client && !this.client.destroyed) {
        this.client.destroy(() => {
           this.deleteFiles();
        });
      } else {
        this.deleteFiles();
      }
    } catch (e) {
      console.error("Erro silencioso ao destruir:", e.message);
      this.deleteFiles();
    }
  }

  deleteFiles() {
    if (fs.existsSync(this.folderPath)) {
      fs.rm(this.folderPath, { recursive: true, force: true }, (err) => {
        if (!err) console.log("🗑️ [CLEANED] Arquivos removidos.");
      });
    }
  }
}

const activeSessions = new Map();

app.get('/', (req, res) => res.send('Stream Engine: ON'));

app.get('/stream', async (req, res) => {
  const magnet = req.query.magnet;
  if (!magnet) return res.status(400).json({ error: 'Magnet Link obrigatório' });

  let session;

  // Reutiliza sessão se existir
  for (let s of activeSessions.values()) {
    if (s.magnet === magnet && !s.isDestroyed) {
      session = s;
      break;
    }
  }

  try {
    if (!session) {
      console.log(`✨ [NEW SESSION] Criando instância...`);
      session = new StreamSession(magnet);
      await session.initialize();
      activeSessions.set(session.infoHash, session);
    }

    session.addViewer();

    const file = session.file;
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
    return res.status(504).json({ error: 'Falha ao iniciar streaming.', details: error.message });
  }
});

// Manipulador de Eventos de Stream Seguro
function handleStreamEvents(stream, req, session) {
  let closed = false;

  const closeStream = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
    session.removeViewer();
  };

  req.on('close', closeStream); // Usuário fechou aba
  
  stream.on('error', (err) => {
    // Ignora erro de fechamento prematuro (é normal quando usuário sai)
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
       closeStream();
    } else {
       console.error("Stream Error (Ignorado):", err.message);
       closeStream();
    }
  });
}

// Limpeza inicial no boot
fs.readdir(CONFIG.DOWNLOAD_ROOT, (err, files) => {
    if(!err) {
        files.forEach(file => {
            const p = path.join(CONFIG.DOWNLOAD_ROOT, file);
            fs.rm(p, { recursive: true, force: true }, () => {});
        });
        console.log("🧹 [BOOT] Limpeza inicial concluída.");
    }
});

process.on('uncaughtException', (err) => {
  console.log('🔥 [CRITICAL] Erro recuperado:', err.message);
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Engine Rodando na porta ${CONFIG.PORT}`);
});