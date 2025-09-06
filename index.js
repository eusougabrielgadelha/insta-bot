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
const {
  DISCORD_TOKEN,
  MAKE_WEBHOOK_URL,
  IG_SESSIONID,   // opcional
  IG_USER,        // opcional
  IG_PASS,        // opcional
  INSTALOADER_BIN // opcional (ex.: /root/.local/bin/instaloader)
} = process.env;

if (!DISCORD_TOKEN || !MAKE_WEBHOOK_URL) {
  console.error('Preencha DISCORD_TOKEN e MAKE_WEBHOOK_URL no .env');
  process.exit(1);
}

const INSTALOADER = INSTALOADER_BIN || 'instaloader';

console.log('[BOOT]', {
  file: __filename,
  cwd: process.cwd(),
  node: process.versions.node,
  PATH: process.env.PATH,
  instaloaderBin: INSTALOADER
});

// ---- Força IPv4 só no transfer.sh (evita IPv6 ruim) ----
const httpsAgentV4 = new https.Agent({
  lookup: (hostname, _opts, cb) => dns.lookup(hostname, { family: 4, all: false }, cb),
});

// ---- Utils ----
async function existsNonEmpty(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

async function instaloaderSupportsSessionId() {
  try {
    const { stdout } = await execFileP(INSTALOADER, ['--help']);
    return /--sessionid\b/.test(stdout || '');
  } catch {
    return false;
  }
}

// ---- Download com Instaloader ----
async function downloadWithInstaloader(instaUrl, tmpDir, id) {
  await fsp.mkdir(tmpDir, { recursive: true });

  const args = [
    '--no-captions',
    '--no-compress-json',
    '--no-metadata-json',
    '--dirname-pattern', tmpDir,
    '--filename-pattern', id
  ];

  // Preferência: LOGIN/SENHA (compatível com qualquer versão)
  if (IG_USER && IG_PASS) {
    args.push('--login', IG_USER, '--password', IG_PASS);
  } else if (IG_SESSIONID) {
    // Só tentar --sessionid se a versão suportar
    const hasSessionId = await instaloaderSupportsSessionId();
    if (hasSessionId) {
      args.push('--sessionid', IG_SESSIONID);
    } else {
      throw new Error(
        'Sua versão do Instaloader não suporta --sessionid. ' +
        'Use IG_USER/IG_PASS no .env OU instale uma versão recente com "pipx install instaloader" ' +
        'e defina INSTALOADER_BIN=/root/.local/bin/instaloader.'
      );
    }
  }
  // alvo (URL) após "--"
  args.push('--', instaUrl);

  console.log('[instaloader CMD]', INSTALOADER, args.join(' '));

  try {
    const { stdout, stderr } = await execFileP(INSTALOADER, args, { maxBuffer: 1024 * 1024 * 1024 });
    if (stdout) console.log('[instaloader stdout]', stdout.split('\n').slice(-20).join('\n'));
    if (stderr) console.log('[instaloader stderr]', stderr.split('\n').slice(-20).join('\n'));
  } catch (e) {
    // Se falhou e você tem IG_USER/IG_PASS, vale exibir dica sobre 2FA/Challenge
    if (IG_USER && IG_PASS) {
      console.warn('[instaloader dica] Se houver 2FA/challenge, rode manualmente "instaloader -l SEUUSER" uma vez para salvar sessão.');
    }
    throw new Error(`Falha no Instaloader: ${e.message}`);
  }

  // 1) nome esperado (id.mp4)
  const expected = nodePath.join(tmpDir, `${id}.mp4`);
  if (await existsNonEmpty(expected)) return expected;

  // 2) se padrão variar, pega o .mp4 mais novo do tmpDir
  const entries = await fsp.readdir(tmpDir);
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith('.mp4')) continue;
    const full = nodePath.join(tmpDir, name);
    const st = await fsp.stat(full).catch(() => null);
    if (st?.isFile()) {
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { full, mtimeMs: st.mtimeMs };
    }
  }
  if (newest?.full) return newest.full;

  throw new Error('Instaloader não gerou .mp4 (pode exigir login/2FA/challenge).');
}

// ---- Uploads (transfer.sh -> 0x0.st -> file.io) ----
async function uploadToTransferSh(localPath) {
  const fileName = nodePath.basename(localPath);
  const url = `https://transfer.sh/${encodeURIComponent(fileName)}`;
  console.log('[upload] transfer.sh ->', url);
  const res = await axios.put(url, fs.createReadStream(localPath), {
    httpsAgent: httpsAgentV4,
    headers: { 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000
  });
  const link = String(res.data || '').trim();
  if (!/^https?:\/\//.test(link)) throw new Error('Upload no transfer.sh não retornou link válido: ' + link);
  return link;
}

async function uploadTo0x0(localPath) {
  console.log('[upload] 0x0.st');
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

async function uploadToFileIO(localPath) {
  console.log('[upload] file.io');
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

// ---- Webhook para o Make ----
async function postToMake({ caption, reelUrl, videoUrl, source = 'discord-bot' }) {
  const payload = { caption, reel_url: reelUrl, video_url: videoUrl, source, ts: new Date().toISOString() };
  const res = await axios.post(MAKE_WEBHOOK_URL, payload, { timeout: 60000, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`Webhook Make retornou HTTP ${res.status}: ${JSON.stringify(res.data)}`);
}

// ---- Discord Bot ----
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// !postar <url-instagram>
const CMD = /^!postar\s+(https?:\/\/\S+)/i;

bot.once('ready', () => console.log(`🤖 Bot online: ${bot.user.tag}`));

bot.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const m = msg.content.match(CMD);
  if (!m) return;

  const url = m[1].trim();

  if (!/https?:\/\/(www\.)?instagram\.com\//i.test(url)) {
    await msg.channel.send('❌ Por enquanto aceito apenas links do Instagram (reels/post).');
    return;
  }

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmpDir = nodePath.join(__dirname, 'tmp');
  let filePath;

  try {
    await msg.channel.send('⬇️ Baixando vídeo do Instagram (Instaloader)…');
    filePath = await downloadWithInstaloader(url, tmpDir, id);

    if (!(await existsNonEmpty(filePath))) {
      throw new Error('Download não gerou arquivo válido.');
    }

    await msg.channel.send('☁️ Enviando arquivo para link público…');
    let publicUrl;
    try {
      publicUrl = await uploadToTransferSh(filePath);
    } catch (err1) {
      console.warn('[transfer.sh falhou]', err1?.message || err1);
      await msg.channel.send('⚠️ transfer.sh indisponível, tentando 0x0.st…');
      try {
        publicUrl = await uploadTo0x0(filePath);
      } catch (err2) {
        console.warn('[0x0.st falhou]', err2?.message || err2);
        await msg.channel.send('⚠️ 0x0.st indisponível, tentando file.io…');
        publicUrl = await uploadToFileIO(filePath);
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

bot.on('error', (e) => console.error('[DISCORD ERROR]', e));
bot.on('shardError', (e) => console.error('[DISCORD SHARD ERROR]', e));
bot.on('warn', (w) => console.warn('[DISCORD WARN]', w));

bot.login(DISCORD_TOKEN);
