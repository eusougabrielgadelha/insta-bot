import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import FormData from 'form-data';
import { Client, GatewayIntentBits } from 'discord.js';
import { chromium } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------ ENV ------------
const { DISCORD_TOKEN, MAKE_WEBHOOK_URL } = process.env;
if (!DISCORD_TOKEN || !MAKE_WEBHOOK_URL) {
  console.error('Preencha DISCORD_TOKEN e MAKE_WEBHOOK_URL no .env');
  process.exit(1);
}

// ------------ Helpers ------------
async function extractMp4FromInsta(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
  });

  let mp4;
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const u = resp.url();
      if (ct.startsWith('video/') && u.includes('.mp4')) mp4 = u;
    } catch {}
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3500); // dá tempo do player requisitar o vídeo
  } finally {
    await browser.close();
  }
  if (!mp4) throw new Error('Não consegui achar o .mp4 deste Reels (pode exigir login/bloqueio).');
  return mp4;
}

async function downloadTo(url, outPath) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
  await fsp.writeFile(outPath, r.data);
  return outPath;
}

// host temporário SEM domínio/IP próprios: file.io
async function uploadToFileIO(localPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(localPath));
  const res = await axios.post('https://file.io', form, {
    headers: form.getHeaders(),
    timeout: 120000
  });
  if (!res.data || !res.data.link) {
    throw new Error('Upload em file.io falhou: ' + JSON.stringify(res.data || {}));
  }
  return res.data.link; // ex.: https://file.io/abcd1234 (link temporário)
}

async function postToMake({ caption, reelUrl, videoUrl, source = 'discord-bot' }) {
  const payload = {
    caption,
    reel_url: reelUrl,
    video_url: videoUrl,
    source,
    ts: new Date().toISOString()
  };
  await axios.post(MAKE_WEBHOOK_URL, payload, { timeout: 60000 });
}

// ------------ Discord Bot ------------
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// aceita -legenda, --legenda ou —legenda (traço longo)
const CMD = /^!postar\s+[-–—]{1,2}legenda\s+(.+?)\s+(https?:\/\/\S+)/i;

bot.on('ready', () => console.log(`🤖 Bot online: ${bot.user.tag}`));

bot.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const m = msg.content.match(CMD);
  if (!m) return;

  const caption = m[1].trim();
  const reelUrl = m[2].trim();

  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmpDir = path.join(__dirname, 'tmp');
  await fsp.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${id}.mp4`);

  try {
    await msg.channel.send('🔎 Buscando vídeo…');
    const mp4 = await extractMp4FromInsta(reelUrl);

    await msg.channel.send('⬇️ Baixando…');
    await downloadTo(mp4, filePath);

    await msg.channel.send('☁️ Gerando link público temporário…');
    const publicUrl = await uploadToFileIO(filePath);

    await msg.channel.send('📨 Enviando ao Make…');
    await postToMake({ caption, reelUrl, videoUrl: publicUrl });

    await msg.channel.send('✅ Enviado! (Make vai processar o post)');
  } catch (e) {
    const detail = e?.response?.data ? JSON.stringify(e.response.data) : String(e);
    console.error(detail);
    await msg.channel.send(`❌ Erro: ${detail}`);
  } finally {
    try { await fsp.unlink(filePath); } catch {}
  }
});

bot.login(DISCORD_TOKEN);
