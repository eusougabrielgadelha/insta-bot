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

// ---- Força IPv4 em HTTPS (evita ETIMEDOUT por IPv6) – usaremos no transfer.sh ----
const httpsAgentV4 = new https.Agent({
  // dns.lookup recebe (hostname, options, callback)
  lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4, all: false }, cb),
});

// ---- Helpers ----

// Monta os argumentos do yt-dlp (com ou sem cookies) – força merge final para mp4
function buildYtDlpArgs(mediaUrl, template, useCookies) {
  const args = [
    '-S', 'ext:mp4:m4v',
    '--no-playlist',
    '--merge-output-format', 'mp4', // saída final mp4
    '-o', template,
    mediaUrl,
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
    if (stdout) console.log('[yt-dlp stdout]', stdout.slice(0, 1000));
    if (stderr) console.log('[yt-dlp stderr]', stderr.slice(0, 1000));
  } catch (e) {
    throw new Error(`Falha no yt-dlp: ${e.message}`);
  }
}

// Baixa do Instagram com fallback de cookies (se disponíveis)
async function downloadFromInstagram(instaUrl, tmpDir, id) {
  await fsp.mkdir(tmpDir, { recursive: true });
  const template = nodePath.join(tmpDir, `${id}.%(ext)s`);

  // 1) sem cookies
  let ok = false;
  try {
    await runYtDlp(buildYtDlpArgs(instaUrl, template, false));
    ok = true;
  } catch (e1) {
    // 2) com cookies (se houver)
    if (IG_COOKIES_FILE || IG_COOKIE || IG_SESSIONID) {
      console.warn('[yt-dlp] sem cookies falhou, tentando com cookies…');
      await runYtDlp(buildYtDlpArgs(instaUrl, template, true));
      ok = true;
    } else {
      throw e1;
    }
  }

  if (!ok) throw new Error('Falha no download.');

  // Preferência: arquivo final “limpo”
  const clean = nodePath.join(tmpDir, `${id}.mp4`);
  if (await existsNonEmpty(clean)) return clean;

  // Procurar MAIOR .mp4 gerado (pode ser fdash-*.mp4)
  const entries = await fsp.readdir(tmpDir);
  const mp4s = [];
  for (const name of entries) {
    if (name.startsWith(id) && name.endsWith('.mp4')) {
      const full = nodePath.join(tmpDir, name);
      const st = await fsp.stat(full).catch(() => null);
      if (st?.isFile() && st.size > 0) mp4s.push({ full, size: st.size });
    }
  }
  if (mp4s.length === 0) throw new Error('yt-dlp não gerou .mp4 (pode ter bloqueio/upstream).');

  // pega o maior
  mp4s.sort((a, b) => b.size - a.size);
  const bestVideoOnly = mp4s[0].full;

  // tenta mesclar com .m4a se existir (ffmpeg)
  try {
    const m4aName = entries.find(n => n.startsWith(id) && n.endsWith('.m4a'));
    if (m4aName) {
      const audioPath = nodePath.join(tmpDir, m4aName);
      const out = nodePath.join(tmpDir, `${id}.mp4`);
      await execFileP('ffmpeg', ['-y', '-i', bestVideoOnly, '-i', audioPath, '-c', 'copy', out],
        { maxBuffer: 1024 * 1024 * 1024 });
      if (await existsNonEmpty(out)) return out;
    }
  } catch (e) {
    console.warn('[ffmpeg merge falhou]', e?.message || e);
  }

  return bestVideoOnly;
}

async function existsNonEmpty(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

// Upload em transfer.sh (IPv4) -> URL pública
async function uploadToTransferSh(localPath) {
  const fileName = nodePath.basename(localPath);
  const stream = fs.createReadStream(localPath);
  const url = `https://transfer.sh/${encodeURIComponent(fileName)}`;
  const res = await axios.put(url, stream, {
    httpsAgent: httpsAgentV4, // força IPv4 aqui
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000
  });
  const link = String(res.data || '').trim();
  if (!/^https?:\/\//.test(link)) throw new Error('Upload no transfer.sh não retornou link válido: ' + link);
  return link;
}

// Fallback 2: 0x0.st (muito simples e estável)
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

// Fallback 3: file.io (sem forçar IPv4)
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

// Dispara para o Make
async function postToMake({ caption, reelUrl, videoUrl, source = 'discord-bot' }) {
  const payload = { caption, reel_url: reelUrl, video_url: videoUrl, source, ts: new Date().toISOString() };
  const res = await axios.post(MAKE_WEBHOOK_URL, payload, { timeout: 60000, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`Webhook Make retornou HTTP ${res.status}: ${JSON.stringify(res.data)}`);
}

// ---- Discord Bot ----
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const CMD = /^!postar\s+(https?:\/\/\S+)/i;

bot.once('ready', () => console.log(`🤖 Bot online: ${bot.user.tag}`));

bot.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const m = msg.content.match(CMD);
  if (!m) return;

  const url = m[1].trim();

  // Apenas Instagram
  if (!/https?:\/\/(www\.)?instagram\.com\//i.test(url)) {
    await msg.channel.send('❌ Por enquanto aceito apenas links do Instagram (reels/post).');
    return;
  }

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmpDir = nodePath.join(__dirname, 'tmp');
  let filePath;

  try {
    await msg.channel.send('⬇️ Baixando vídeo do Instagram…');
    filePath = await downloadFromInstagram(url, tmpDir, id);

    // sanity check
    if (!(await existsNonEmpty(filePath))) {
      throw new Error('Download não gerou arquivo válido.');
    }

    await msg.channel.send('☁️ Enviando arquivo para link público…');
    let publicUrl;
    try {
      publicUrl = await uploadToTransferSh(filePath);      // 1º
    } catch (err1) {
      console.warn('[transfer.sh falhou]', err1?.message || err1);
      await msg.channel.send('⚠️ transfer.sh indisponível, tentando 0x0.st…');
      try {
        publicUrl = await uploadTo0x0(filePath);           // 2º
      } catch (err2) {
        console.warn('[0x0.st falhou]', err2?.message || err2);
        await msg.channel.send('⚠️ 0x0.st indisponível, tentando file.io…');
        publicUrl = await uploadToFileIO(filePath);        // 3º
      }
    }

    await msg.channel.send('📨 Disparando para o Make…');
    await postToMake({ caption: '', reelUrl: url, videoUrl: publicUrl });

    await msg.channel.send('✅ Enviado! (Make vai processar o post)');
  } catch (e) {
    console.error(e);
    await msg.channel.send(`❌ Erro: ${e.message}`);
  } finally {
    if (filePath) { try { await fsp.unlink(filePath); } catch {} }
  }
});

// Logs úteis
bot.on('error', (e) => console.error('[DISCORD ERROR]', e));
bot.on('shardError', (e) => console.error('[DISCORD SHARD ERROR]', e));
bot.on('warn', (w) => console.warn('[DISCORD WARN]', w));

bot.login(DISCORD_TOKEN);
