import express from 'express';
import WebTorrent from 'webtorrent';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// === CONFIGURAÇÕES DE ESCALA ===
const CONFIG = {
  MAX_ACTIVE_TORRENTS: 20,     
  INACTIVITY_TIMEOUT: 60000,   
  DELETE_FILE_TIMEOUT: 1000,   
  DOWNLOAD_ROOT: 'downloads',
  PORT: 8080,
  JANITOR_INTERVAL: 10 * 60 * 1000 
};

const __filename = fileURLToPath(import.meta.url);
const app = express();

// Configuração do Cliente Torrent
const client = new WebTorrent({ 
  maxConns: 200, 
  uploadLimit: 1024 * 1024 
}); 

// Tratamento de erros do cliente para não derrubar o app
client.on('error', (err) => {
  console.error('🔥 [CLIENT ERROR]', err.message);
});

const activeStreams = new Map();

app.use(cors());

// Cria pasta raiz se não existir
if (!fs.existsSync(CONFIG.DOWNLOAD_ROOT)) {
  fs.mkdirSync(CONFIG.DOWNLOAD_ROOT);
}

// === O ZELADOR (JANITOR) ===
setInterval(() => {
  console.log('🧹 [JANITOR] Iniciando varredura de disco...');
  fs.readdir(CONFIG.DOWNLOAD_ROOT, (err, files) => {
    if (err) return;
    
    files.forEach(file => {
      const filePath = path.join(CONFIG.DOWNLOAD_ROOT, file);
      
      const isActive = client.torrents.some(t => {
          return t.path.includes(file) || (t.files && t.files[0] && t.files[0].path.includes(file));
      });

      if (!isActive) {
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          const now = Date.now();
          // Se o arquivo tem mais de 20 minutos e não está ativo -> LIXO
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
  if (!magnet) return res.status(400).send('Magnet Link necessário');

  // 1. Verifica se já existe
  const existing = client.get(magnet);
  
  // === CORREÇÃO DO ERRO AQUI ===
  // Verificamos se 'existing' é válido, se não está destruído e se tem as funções necessárias
  if (existing) {
    if (existing.destroyed || typeof existing.once !== 'function') {
      console.warn(`⚠️ [WARN] Torrent encontrado em estado inválido (Zumbi). Ignorando...`);
      // Não damos return aqui, deixamos o código fluir para tentar adicionar novamente
      // ou removemos do cliente se estiver travado
      try { client.remove(magnet); } catch(e) {}
    } else {
      console.log(`🔄 [HIT] Usuário entrou em sessão existente: ${existing.name || 'Carregando...'}`);
      registerViewer(existing.infoHash);
      
      if (existing.ready) {
        serveFile(existing, req, res);
      } else {
        existing.once('ready', () => serveFile(existing, req, res));
      }
      return;
    }
  }

  // 2. Se não existe (ou estava inválido), verifica capacidade
  if (client.torrents.length >= CONFIG.MAX_ACTIVE_TORRENTS) {
    const candidate = client.torrents.find(t => {
      const stats = activeStreams.get(t.infoHash);
      return !stats || stats.viewers === 0;
    });

    if (candidate) {
      console.log(`⚠️ [FULL] Capacidade máxima. Despejando inativo: ${candidate.name}`);
      forceRemove(candidate.infoHash);
    } else {
      return res.status(503).send('Servidor sobrecarregado. Tente novamente em breve.');
    }
  }

  // 3. Inicia Download
  const uniquePath = path.join(CONFIG.DOWNLOAD_ROOT, Date.now().toString());

  try {
    client.add(magnet, { path: uniquePath }, (torrent) => {
      console.log(`🚀 [NEW] Stream iniciado: ${torrent.name}`);
      
      activeStreams.set(torrent.infoHash, {
        viewers: 1,
        timer: null,
        folderPath: uniquePath
      });

      // Monitor básico de progresso
      const interval = setInterval(() => {
          if (torrent.destroyed) { clearInterval(interval); return; }
      }, 5000);

      serveFile(torrent, req, res);
    });
  } catch (err) {
    console.error("❌ Erro ao adicionar torrent:", err.message);
    res.status(500).send("Erro ao iniciar torrent.");
  }
});

function registerViewer(infoHash) {
  if (!infoHash) return; // Proteção extra
  const stats = activeStreams.get(infoHash);
  if (stats) {
    stats.viewers++;
    if (stats.timer) {
      console.log(`👤 [USER] Novo espectador. Cancelando exclusão.`);
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
      console.log(`⏳ [TIMER] 0 Espectadores. Exclusão agendada.`);
      
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
    console.log(`🛑 [STOP] Parando download: ${torrent.name}`);
    torrent.destroy(() => {
      activeStreams.delete(infoHash);
      
      if (stats && stats.folderPath) {
        console.log(`🗑️ [CLEANUP] Apagando arquivos: ${stats.folderPath}`);
        try {
          fs.rm(stats.folderPath, { recursive: true, force: true }, (err) => {
             if (err) console.error("Erro ao apagar arquivo:", err);
          });
        } catch (e) {
          console.error("Erro de permissão ao apagar:", e);
        }
      }
    });
  }
}

function serveFile(torrent, req, res) {
  if (!torrent || !torrent.files) {
      return res.status(500).send("Torrent inválido ou sem arquivos.");
  }

  const file = torrent.files.find(f => f.name.endsWith('.mp4') || f.name.endsWith('.mkv') || f.name.endsWith('.avi'));

  if (!file) return res.status(404).send('Vídeo não encontrado.');

  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': file.length,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });
    const stream = file.createReadStream();
    stream.pipe(res);
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
  console.log('🔥 [CRITICAL] Erro não tratado recuperado:', err.message);
  // Mantém o servidor vivo
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Engine Blindada Rodando na porta ${CONFIG.PORT}`);
  console.log(`💾 Salvando em: ${CONFIG.DOWNLOAD_ROOT}`);
});