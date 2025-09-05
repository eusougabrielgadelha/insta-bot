// ---- Carrega .env da mesma pasta (independe do CWD do PM2) ----
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

// ---- ENV (somente Instagram) ----
const {
  DISCORD_TOKEN,
  MAKE_WEBHOOK_URL,
  IG_COOKIES_FILE,  // caminho do cookies.txt (Netscape) — preferível
  IG_COOKIE,        // linha completa de Cookie (ex.: 'sessionid=...; csrftoken=...')
  IG_SESSIONID      // fallback simples: só o sessionid
} = process.env;

if (!DISCORD_TOKEN || !MAKE_WEBHOOK_URL) {
  console.error('Preencha DISCORD_TOKEN e MAKE_WEBHOOK_URL no .env');
  process.exit(1);
}
console.log('[BOOT]', { file: __filename, cwd: process.cwd(), node: process.versions.node });

// ---- HTTPS IPv4 apenas para transfer.sh (evita ETIMEDOUT via IPv6) ----
const httpsAgentV4 = new https.Agent({
  lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4, all: false }, cb)
});

// ---------- Helpers Instagram/URL ----------
function isInstagram(url) {
  try { return new URL(url).hostname.includes('instagram.com'); }
  catch { return false; }
}

// remove query/fragment; mantém caminho original (/reel/, /p/, /tv/ etc.)
function sanitizeInstagramUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

// ---------- yt-dlp helpers (Instagram) ----------

// Monta args do yt-dlp (força saída mp4 e usa cookies se disponíveis)
function buildYtDlpArgs(igUrl, template, useCookies) {
  const args = [
    '-S', 'ext:mp4:m4v',
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    '-o', template,
    igUrl
  ];

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

// Download apenas do Instagram
async function downloadInstagram(igUrl, tmpDir, id) {
  if (!isInstagram(igUrl)) {
    throw new Error('URL não é do Instagram.');
  }

  await fsp.mkdir(tmpDir, { recursive: true });
  const template = nodePath.join(tmpDir, `${id}.%(ext)s`);

  // Estratégia: tentar PRIMEIRO com cookies (IG quase sempre exige login), depois sem.
  const hasAnyCookie = !!(IG_COOKIES_FILE || IG_COOKIE || IG_SESSIONID);

  try {
    if (hasAnyCookie) {
      console.log('[yt-dlp] tentando com cookies IG…');
      await runYtDlp(buildYtDlpArgs(igUrl, template, true));
    } else {
      console.log('[yt-dlp] tentando sem cookies…');
      await runYtDlp(buildYtDlpArgs(igUrl, template, false));
    }
  } catch (e1) {
    if (hasAnyCookie) {
      console.warn('[yt-dlp] com cookies falhou, tentando SEM cookies…');
      await runYtDlp(buildYtDlpArgs(igUrl, template, false));
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
      await execFileP('ffmpeg', ['-y', '-i', bestVideoOnly, '-i', audioPath, '-c', 'copy', out],
        { maxBuffer: 1024 * 1024 * 1024 });
      return out;
    }
  } catch (e) {
    console.warn('[ffmpeg merge falhou]', e?.message || e);
  }

  // Sem merge, segue com o melhor .mp4 (pode ficar sem áudio)
  return bestVideoOnly;
}

// ---------- Upload helpers ----------
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

// ---------- Make ----------
async function postToMake({ caption, reelUrl, videoUrl, source = 'discord-bot' }) {
  const payload = { caption, reel_url: reelUrl, video_url: videoUrl, source, ts: new Date().toISOString() };
  const res = await axios.post(MAKE_WEBHOOK_URL, payload, { timeout: 60000, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`Webhook Make retornou HTTP ${res.status}: ${JSON.stringify(res.data)}`);
}

// ---------- Discord Bot ----------
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Aceita: !postar --legenda <texto> <URL-Instagram>
const CMD = /^!postar\s+[-–—]{1,2}legenda\s+(.+?)\s+(https?:\/\/\S+)/i;

bot.once('ready', () => console.log(`🤖 Bot online: ${bot.user.tag}`));

bot.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const m = msg.content.match(CMD);
  if (!m) return;

  const caption = m[1].trim();
  const rawUrl = m[2].trim();
  const igUrl = sanitizeInstagramUrl(rawUrl);

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmpDir = nodePath.join(__dirname, 'tmp');
  let filePath;

  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // 1) DOWNLOAD
    await msg.channel.send('⬇️ Baixando vídeo do Instagram…');
    filePath = await downloadInstagram(igUrl, tmpDir, id);
    await fsp.access(filePath); // sanity-check
    console.log('[DL DONE]', { id, filePath });

    // 2) UPLOAD (com fallbacks)
    await msg.channel.send('☁️ Enviando arquivo para link público…');
    let publicUrl;
    try {
      publicUrl = await uploadToTransferSh(filePath);
    } catch (err1) {
      console.warn('[transfer.sh falhou]', err1?.message || err1);
      await msg.channel.send('⚠️ transfer.sh indisponível, tentando file.io…');
      try {
        publicUrl = await uploadToFileIO(filePath);
      } catch (err2) {
        console.warn('[file.io falhou]', err2?.message || err2);
        await msg.channel.send('⚠️ file.io indisponível, tentando 0x0.st…');
        publicUrl = await uploadTo0x0(filePath);
      }
    }

    // 3) MAKE
    await msg.channel.send('📨 Disparando para o Make…');
    await postToMake({ caption, reelUrl: igUrl, videoUrl: publicUrl });

    await msg.channel.send('✅ Enviado! (Make vai processar o post)');
  } catch (e) {
    console.error(e);
    await msg.channel.send(`❌ Erro: ${e.message}`);
  } finally {
    if (filePath) { try { await fsp.unlink(filePath); } catch {} }
  }
});

// Logs úteis do Discord
bot.on('error', (e) => console.error('[DISCORD ERROR]', e));
bot.on('shardError', (e) => console.error('[DISCORD SHARD ERROR]', e));
bot.on('warn', (w) => console.warn('[DISCORD WARN]', w));

bot.login(DISCORD_TOKEN);
