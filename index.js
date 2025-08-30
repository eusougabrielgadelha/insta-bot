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
const { DISCORD_TOKEN, MAKE_WEBHOOK_URL, IG_SESSIONID, IG_COOKIE, IG_COOKIES_FILE } = process.env;
if (!DISCORD_TOKEN || !MAKE_WEBHOOK_URL) {
  console.error('Preencha DISCORD_TOKEN e MAKE_WEBHOOK_URL no .env');
  process.exit(1);
}
console.log('[BOOT]', { file: __filename, cwd: process.cwd(), node: process.versions.node });

// ---- Força IPv4 em HTTPS (evita ETIMEDOUT por IPv6) – usaremos só no transfer.sh ----
const httpsAgentV4 = new https.Agent({
  lookup: (hostname, options, cb) => dns.lookup(hostname, { family: 4, all: false }, cb)
});

// ---------- yt-dlp helpers ----------

// Monta os argumentos do yt-dlp (com ou sem cookies) – força merge para mp4
function buildYtDlpArgs(mediaUrl, template, useCookies) {
  const args = [
    '-S', 'ext:mp4:m4v',
    '--no-playlist',
    '--merge-output-format', 'mp4',     // força saída final mp4
    '-o', template,
    mediaUrl
  ];

  // Cookies (só serão úteis para Instagram/privados; TikTok costuma baixar sem)
  if (useCookies) {
    if (IG_COOKIES_FILE) {
      args.unshift('--cookies', IG_COOKIES_FILE);
    } else if (IG_COOKIE) {
      args.unshift('--add-header', `Cookie: ${IG_COOKIE}`);
    } else if (IG_SESSIONID) {
      args.unshift('--add-header', `Cookie: sessionid=${IG_SESSIONID}`);
    }
  }
  return args;
}

async function runYtDlp(args) {
  try {
    const { stdout, stderr } = await execFileP('yt-dlp', args, { maxBuffer: 1024 * 1024 * 1024 });
    if (stdout) console.log('[yt-dlp stdout]', stdout.slice(0, 2000));
    if (stderr) console.log('[yt-dlp stderr]', stderr.slice(0, 2000));
  } catch (e) {
    throw new Error(`Falha no yt-dlp: ${e.message}`);
  }
}

// Download genérico (TikTok/Instagram/etc.)
async function downloadWithYtDlp(mediaUrl, tmpDir, id) {
  await fsp.mkdir(tmpDir, { recursive: true });
  const template = nodePath.join(tmpDir, `${id}.%(ext)s`);

  // 1) tentativa sem cookies
  try {
    await runYtDlp(buildYtDlpArgs(mediaUrl, template, false));
  } catch (e1) {
    // 2) se temos cookies configurados, tenta de novo
    if (IG_COOKIES_FILE || IG_COOKIE || IG_SESSIONID) {
      console.warn('[yt-dlp] sem cookies falhou, tentando com cookies…');
      await runYtDlp(buildYtDlpArgs(mediaUrl, template, true));
    } else {
      throw e1;
    }
  }

  // Preferência: arquivo final “limpo”
  const clean = nodePath.join(tmpDir, `${id}.mp4`);
  try { await fsp.access(clean); return clean; } catch {}

  // Se não há “limpo”, procurar o MAIOR .mp4 gerado (pode ser fdash-*.mp4)
  const entries = await fsp.readdir(tmpDir);
  const mp4s = [];
  for (const name of entries) {
    if (name.startsWith(id) && name.endsWith('.mp4')) {
      const full = nodePath.join(tmpDir, name);
      const st = await fsp.stat(full).catch(() => null);
      if (st?.isFile()) mp4s.push({ full, size: st.size, name });
    }
  }
  if (mp4s.length === 0) throw new Error('yt-dlp não gerou .mp4 (talvez bloqueio ou erro upstream).');

  // Pega o maior .mp4 (normalmente é o vídeo principal)
  mp4s.sort((a, b) => b.size - a.size);
  const bestVideoOnly = mp4s[0].full;

  // Tentar mesclar com o .m4a se houver FFmpeg + áudio
  try {
    const m4a = entries.find(n => n.startsWith(id) && n.endsWith('.m4a'));
    if (m4a) {
      const audioPath = nodePath.join(tmpDir, m4a);
      const out = nodePath.join(tmpDir, `${id}.mp4`);
      // usa ffmpeg (precisa estar instalado)
      await execFileP('ffmpeg', [
        '-y',
        '-i', bestVideoOnly,
        '-i', audioPath,
        '-c', 'copy',
        out
      ], { maxBuffer: 1024 * 1024 * 1024 });
      // se tudo ok, retornar o merged
      return out;
    }
  } catch (e) {
    console.warn('[ffmpeg merge falhou]', e?.message || e);
  }

  // Sem merge, segue com o melhor .mp4 (pode ficar sem áudio)
  return bestVideoOnly;
}

// ---------- Upload helpers ----------

// Upload em transfer.sh (IPv4) -> URL pública
async function uploadToTransferSh(localPath) {
  const fileName = nodePath.basename(localPath);
  const stream = fs.createReadStream(localPath);
  const url = `https://transfer.sh/${encodeURIComponent(fileName)}`;
  const res = await axios.put(url, stream, {
    httpsAgent: httpsAgentV4, // IPv4 apenas aqui
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000
  });
  const link = String(res.data || '').trim();
  if (!link.startsWith('https://')) throw new Error('Upload no transfer.sh não retornou link válido: ' + link);
  return link;
}

// Fallback 1: upload em file.io -> URL pública (sem httpsAgent)
async function uploadToFileIO(localPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(localPath));
  const res = await axios.post('https://file.io', form, {
    headers: form.getHeaders(),
    timeout: 180000,
    maxBodyLength: Infinity
  });
  if (!res.data || !res.data.link) throw new Error('Upload no file.io falhou: ' + JSON.stringify(res.data || {}));
  return String(res.data.link).trim();
}

// Fallback 2: upload em 0x0.st -> URL pública
async function uploadTo0x0(localPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(localPath));
  const res = await axios.post('https://0x0.st', form, {
    headers: form.getHeaders(),
    timeout: 180000,
    maxBodyLength: Infinity
  });
  const link = String(res.data || '').trim();
  if (!/^https?:\/\/0x0\.st\/\w+/.test(link)) {
    throw new Error('Upload no 0x0.st não retornou link válido: ' + link);
  }
  return link;
}

// Envia payload para o Make
async function postToMake({ caption, reelUrl, videoUrl, source = 'discord-bot' }) {
  const payload = { caption, reel_url: reelUrl, video_url: videoUrl, source, ts: new Date().toISOString() };
  const res = await axios.post(MAKE_WEBHOOK_URL, payload, { timeout: 60000, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`Webhook Make retornou HTTP ${res.status}: ${JSON.stringify(res.data)}`);
}

// ---------- Discord Bot ----------

const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Aceita qualquer URL após a legenda
const CMD = /^!postar\s+[-–—]{1,2}legenda\s+(.+?)\s+(https?:\/\/\S+)/i;

bot.once('ready', () => console.log(`🤖 Bot online: ${bot.user.tag}`));

bot.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const m = msg.content.match(CMD);
  if (!m) return;

  const caption = m[1].trim();
  const mediaUrl = m[2].trim(); // TikTok/Instagram/etc.

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmpDir = nodePath.join(__dirname, 'tmp');
  let filePath;

  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // 1) DOWNLOAD
    await msg.channel.send('⬇️ Baixando vídeo (yt-dlp)…');
    filePath = await downloadWithYtDlp(mediaUrl, tmpDir, id);

    // sanity-check
    if (!filePath) throw new Error('Download falhou: nenhum arquivo gerado pelo yt-dlp');
    await fsp.access(filePath); // lança se não existir
    console.log('[DL DONE]', { id, tmpDir, filePath });

    // 2) UPLOAD (com 3 fallbacks)
    await msg.channel.send('☁️ Enviando arquivo para link público…');
    let publicUrl;
    try {
      publicUrl = await uploadToTransferSh(filePath);               // 1º
    } catch (err1) {
      console.warn('[transfer.sh falhou]', err1?.message || err1);
      await msg.channel.send('⚠️ transfer.sh indisponível, tentando file.io…');
      try {
        publicUrl = await uploadToFileIO(filePath);                 // 2º
      } catch (err2) {
        console.warn('[file.io falhou]', err2?.message || err2);
        await msg.channel.send('⚠️ file.io indisponível, tentando 0x0.st…');
        publicUrl = await uploadTo0x0(filePath);                    // 3º
      }
    }

    // 3) MAKE WEBHOOK
    await msg.channel.send('📨 Disparando para o Make…');
    await postToMake({ caption, reelUrl: mediaUrl, videoUrl: publicUrl });

    await msg.channel.send('✅ Enviado! (Make vai processar o post)');
  } catch (e) {
    console.error(e);
    await msg.channel.send(`❌ Erro: ${e.message}`);
  } finally {
    if (filePath) {
      try { await fsp.unlink(filePath); } catch {}
    }
  }
});

// Logs úteis do Discord
bot.on('error', (e) => console.error('[DISCORD ERROR]', e));
bot.on('shardError', (e) => console.error('[DISCORD SHARD ERROR]', e));
bot.on('warn', (w) => console.warn('[DISCORD WARN]', w));

bot.login(DISCORD_TOKEN);
