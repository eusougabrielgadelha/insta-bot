// ---- .env da mesma pasta (independe do CWD do PM2) ----
import dotenv from 'dotenv';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);
dotenv.config({ path: nodePath.join(__dirname, '.env') });

// ---- Deps ----
import fs from 'fs';
import fsp from 'fs/promises';
import axios from 'axios';
import FormData from 'form-data';
import https from 'node:https';
import dns from 'node:dns';
import { Client, GatewayIntentBits } from 'discord.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

// ---- ENV ----
const { DISCORD_TOKEN, MAKE_WEBHOOK_URL } = process.env;
if (!DISCORD_TOKEN || !MAKE_WEBHOOK_URL) {
  console.error('Preencha DISCORD_TOKEN e MAKE_WEBHOOK_URL no .env');
  process.exit(1);
}

console.log('[BOOT]', { file: __filename, cwd: process.cwd(), node: process.versions.node });

// ---- Força IPv4 em requisições HTTPS (resolve ETIMEDOUT via IPv6) ----
const httpsAgentV4 = new https.Agent({
  lookup: (hostname, options, cb) => dns.lookup(hostname, { family: 4, all: false }, cb)
});

// ---- Helpers ----

// Baixa o vídeo do Reels com yt-dlp (gera arquivo local em tmp/)
async function downloadReelWithYtDlp(reelUrl, tmpDir, id) {
  await fsp.mkdir(tmpDir, { recursive: true });
  const template = nodePath.join(tmpDir, `${id}.%(ext)s`);
  const args = [
    '-S', 'ext:mp4:m4v',   // prioriza MP4/M4V
    '--no-playlist',
    '-o', template,
    reelUrl
  ];
  try {
    const { stdout, stderr } = await execFileP('yt-dlp', args, { maxBuffer: 1024 * 1024 * 1024 });
    if (stdout) console.log('[yt-dlp stdout]', stdout.slice(0, 1000));
    if (stderr) console.log('[yt-dlp stderr]', stderr.slice(0, 1000));
  } catch (e) {
    throw new Error(`Falha no yt-dlp: ${e.message}`);
  }

  // Detecta o arquivo baixado
  const exts = ['mp4', 'm4v', 'mov', 'mkv', 'webm'];
  for (const ext of exts) {
    const p = nodePath.join(tmpDir, `${id}.${ext}`);
    try { await fsp.access(p); return p; } catch {}
  }
  throw new Error('yt-dlp não gerou arquivo de saída esperado.');
}

// Upload em transfer.sh (IPv4) -> retorna URL pública
async function uploadToTransferSh(localPath) {
  const fileName = nodePath.basename(localPath);
  const stream = fs.createReadStream(localPath);
  const url = `https://transfer.sh/${encodeURIComponent(fileName)}`;
  const res = await axios.put(url, stream, {
    httpsAgent: httpsAgentV4,
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000
  });
  const link = String(res.data || '').trim();
  if (!link.startsWith('https://')) throw new Error('Upload no transfer.sh não retornou link válido: ' + link);
  return link;
}

// Fallback: upload em file.io -> retorna URL pública
async function uploadToFileIO(localPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(localPath));
  const res = await axios.post('https://file.io', form, {
    httpsAgent: httpsAgentV4,
    headers: form.getHeaders(),
    timeout: 180000,
    maxBodyLength: Infinity
  });
  if (!res.data || !res.data.link) throw new Error('Upload no file.io falhou: ' + JSON.stringify(res.data || {}));
  return String(res.data.link).trim();
}

// Envia payload para o Make
async function postToMake({ caption, reelUrl, videoUrl, source = 'discord-bot' }) {
  const payload = { caption, reel_url: reelUrl, video_url: videoUrl, source, ts: new Date().toISOString() };
  const res = await axios.post(MAKE_WEBHOOK_URL, payload, { timeout: 60000, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`Webhook Make retornou HTTP ${res.status}: ${JSON.stringify(res.data)}`);
}

// ---- Discord Bot ----
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// aceita -legenda, --legenda ou —legenda (traço longo)
const CMD = /^!postar\s+[-–—]{1,2}legenda\s+(.+?)\s+(https?:\/\/\S+)/i;

bot.once('ready', () => console.log(`🤖 Bot online: ${bot.user.tag}`));

bot.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const m = msg.content.match(CMD);
  if (!m) return;

  const caption = m[1].trim();
  const reelUrl = m[2].trim();

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmpDir = nodePath.join(__dirname, 'tmp');
  let filePath;

  try {
    await msg.channel.send('⬇️ Baixando vídeo (yt-dlp)…');
    filePath = await downloadReelWithYtDlp(reelUrl, tmpDir, id);

    await msg.channel.send('☁️ Enviando arquivo para link público…');
    let publicUrl;
    try {
      publicUrl = await uploadToTransferSh(filePath);
    } catch (err1) {
      console.warn('[transfer.sh falhou]', err1?.message || err1);
      await msg.channel.send('⚠️ transfer.sh indisponível, tentando file.io…');
      publicUrl = await uploadToFileIO(filePath);
    }

    await msg.channel.send('📨 Disparando para o Make…');
    await postToMake({ caption, reelUrl, videoUrl: publicUrl });

    await msg.channel.send('✅ Enviado! (Make vai processar o post)');
  } catch (e) {
    console.error(e);
    await msg.channel.send(`❌ Erro: ${e.message}`);
  } finally {
    if (filePath) { try { await fsp.unlink(filePath); } catch {} }
  }
});

// Handlers de diagnóstico
bot.on('error', (e) => console.error('[DISCORD ERROR]', e));
bot.on('shardError', (e) => console.error('[DISCORD SHARD ERROR]', e));
bot.on('warn', (w) => console.warn('[DISCORD WARN]', w));

bot.login(DISCORD_TOKEN);
