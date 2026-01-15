import express from 'express';
import WebTorrent from 'webtorrent';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// === CONFIGURAÇÕES ===
const CONFIG = {
  MAX_ACTIVE_TORRENTS: 20,     
  INACTIVITY_TIMEOUT: 60000,   
  DELETE_FILE_TIMEOUT: 1000,   
  DOWNLOAD_ROOT: 'downloads',
  PORT: 8080,
  JANITOR_INTERVAL: 2 * 60 * 1000 
};

const __filename = fileURLToPath(import.meta.url);
const app = express();

const client = new WebTorrent({ 
  maxConns: 200, 
  uploadLimit: 1024 * 1024 
}); 

client.on('error', (err) => {
  console.error('🔥 [CLIENT ERROR]', err.message);
});

const activeStreams = new Map();

app.use(cors());

if (!fs.existsSync(CONFIG.DOWNLOAD_ROOT)) {
  fs.mkdirSync(CONFIG.DOWNLOAD_ROOT);
}

// === ZELADOR (JANITOR) ===
setInterval(() => {
  console.log('🧹 [JANITOR] Iniciando varredura de disco...');
  fs.readdir(CONFIG.DOWNLOAD_ROOT, (err, files) => {
    if (err) return;
    
    files.forEach(file => {
      const filePath = path.join(CONFIG.DOWNLOAD_ROOT, file);
      
      const isActive = client.torrents.some(t => {
          return t.path && (t.path.includes(file) || (t.files && t.files[0] && t.files[0].path.includes(file)));
      });

      if (!isActive) {
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          const now = Date.now();
          if (now - stats.mtimeMs > 20 * 60 * 1000) {
             console.log(`🗑️ [JANITOR] Removendo arquivo órfão: ${file}`);
             try { fs.rmSync(filePath, { recursive: true, force: true }); } catch(e) {}
          }
        });
      }
    });
  });
}, CONFIG.JANITOR_INTERVAL);


app.get('/', (req, res) => res.send('Stream Engine: ON (Stable Mode)'));

app.get('/stream', (req, res) => {
  const magnet = req.query.magnet;
  if (!magnet || magnet === 'undefined') return res.status(400).send('Magnet Link inválido');

  // Verifica se já existe
  const existing = client.get(magnet);
  
  if (existing) {
    if (existing.destroyed || typeof existing.once !== 'function') {
      console.warn(`⚠️ [WARN] Torrent Zumbi encontrado. Removendo da memória...`);
      try { client.remove(magnet); } catch(e) {}
    } else {
      console.log(`🔄 [HIT] Sessão existente: ${existing.name || '...'}`);
      registerViewer(existing.infoHash);
      if (existing.ready) {
        serveFile(existing, req, res);
      } else {
        existing.once('ready', () => serveFile(existing, req, res));
      }
      return;
    }
  }

  // Limite de capacidade
  if (client.torrents.length >= CONFIG.MAX_ACTIVE_TORRENTS) {
    const candidate = client.torrents.find(t => {
      const stats = activeStreams.get(t.infoHash);
      return !stats || stats.viewers === 0;
    });

    if (candidate) {
      console.log(`⚠️ [FULL] Liberando espaço: ${candidate.name || candidate.infoHash}`);
      forceRemove(candidate.infoHash);
    } else {
      return res.status(503).send('Servidor cheio. Tente novamente em instantes.');
    }
  }

  // Inicia novo download
  const uniquePath = path.join(CONFIG.DOWNLOAD_ROOT, Date.now().toString());

  try {
    client.add(magnet, { path: uniquePath }, (torrent) => {
      console.log(`🚀 [NEW] Stream iniciado: ${torrent.name}`);
      
      activeStreams.set(torrent.infoHash, {
        viewers: 1,
        timer: null,
        folderPath: uniquePath
      });

      serveFile(torrent, req, res);
    });
  } catch (err) {
    console.error("❌ Erro ao adicionar torrent:", err.message);
    res.status(500).send("Erro interno no torrent.");
  }
});

function registerViewer(infoHash) {
  if (!infoHash) return;
  const stats = activeStreams.get(infoHash);
  if (stats) {
    stats.viewers++;
    if (stats.timer) {
      clearTimeout(stats.timer);
      stats.timer = null;
    }
    activeStreams.set(infoHash, stats);
  }
}

function unregisterViewer(infoHash) {
  const stats = activeStreams.get(infoHash);
  if (stats) {
    stats.viewers--;
    if (stats.viewers <= 0) {
      stats.viewers = 0;
      stats.timer = setTimeout(() => {
        forceRemove(infoHash);
      }, CONFIG.INACTIVITY_TIMEOUT);
    }
    activeStreams.set(infoHash, stats);
  }
}

function forceRemove(infoHash) {
  const torrent = client.get(infoHash);
  const stats = activeStreams.get(infoHash);
  
  if (torrent) {
    console.log(`🛑 [STOP] Parando download: ${torrent.name || infoHash}`);
    try {
        // CORREÇÃO: Verifica se destroy é uma função antes de chamar
        if (typeof torrent.destroy === 'function') {
            torrent.destroy(() => cleanupFile(infoHash, stats));
        } else {
            // Se estiver bugado, remove do cliente na força bruta
            client.remove(infoHash);
            cleanupFile(infoHash, stats);
        }
    } catch(e) {
        console.error("Erro ao destruir torrent:", e.message);
        cleanupFile(infoHash, stats);
    }
  } else {
      cleanupFile(infoHash, stats);
  }
  activeStreams.delete(infoHash);
}

function cleanupFile(infoHash, stats) {
    if (stats && stats.folderPath) {
        try {
          fs.rm(stats.folderPath, { recursive: true, force: true }, () => {});
        } catch (e) {}
    }
}

function serveFile(torrent, req, res) {
  if (!torrent || !torrent.files) return res.status(500).send("Erro no arquivo.");
  
  // Tenta achar vídeo. Se não achar, pega o maior arquivo.
  let file = torrent.files.find(f => f.name.match(/\.(mp4|mkv|avi|webm)$/i));
  if (!file) {
      file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
  }

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Length': file.length,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });
    const stream = file.createReadStream();
    stream.pipe(res);
    stream.on('error', () => {}); 
    monitorConnection(stream, torrent.infoHash, req);
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
    stream.pipe(res);
    stream.on('error', () => {});
    monitorConnection(stream, torrent.infoHash, req);
  }
}

function monitorConnection(stream, infoHash, req) {
  req.on('close', () => {
    stream.destroy();
    unregisterViewer(infoHash);
  });
}

process.on('uncaughtException', (err) => {
  console.log('🔥 [CRITICAL] Erro recuperado:', err.message);
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Engine Rodando na porta ${CONFIG.PORT}`);
});