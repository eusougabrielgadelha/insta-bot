// /root/insta-bot/get_ig_cookie.js
import { chromium } from '@playwright/test';
import fs from 'fs';
import * as path from 'node:path';

const IG_USER = process.env.IG_USER || '';
const IG_PASS = process.env.IG_PASS || '';
const OUT = process.env.OUT || '/root/insta-bot/cookies.txt';
const HEADLESS = (process.env.HEADLESS ?? 'true').toLowerCase() !== 'false'; // default: true
const EXTRA_WAIT_MS = Number(process.env.EXTRA_WAIT_MS || 3000);
const TIMEOUT = Number(process.env.TIMEOUT || 90000);

if (!IG_USER || !IG_PASS) {
  console.error('Defina IG_USER e IG_PASS. Ex.: IG_USER=meuuser IG_PASS=mins3nh@ node get_ig_cookie.js');
  process.exit(1);
}

function toNetscapeCookieLines(cookies) {
  const header = '# Netscape HTTP Cookie File';
  const lines = [header];
  for (const c of cookies) {
    if (!/instagram\.com$/i.test(c.domain || '')) continue;
    const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain.replace(/^\./, '')}`;
    const includeSub = 'TRUE';
    const p = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const exp = c.expires ? Math.floor(c.expires) : 2147483647;
    const name = c.name;
    const value = c.value ?? '';
    if (!name) continue;
    lines.push([domain, includeSub, p, secure, exp, name, value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// tenta fechar banners de cookies (PT/EN) – desktop e mobile
async function acceptCookies(page) {
  const candidates = [
    // botões comuns
    'button:has-text("Allow all cookies")',
    'button:has-text("Only allow essential cookies")',
    'button:has-text("Permitir todos os cookies")',
    'button:has-text("Permitir apenas cookies essenciais")',
    // algumas variantes
    'text=/Allow all|Only allow essential|Permitir todos|apenas cookies/i >> button',
    // mobile
    'div[role="dialog"] button:has-text("Accept")',
    'div[role="dialog"] button:has-text("Aceitar")',
  ];
  for (const sel of candidates) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      try { await btn.click({ timeout: 2000 }); } catch {}
    }
  }
}

// espera qualquer versão do formulário de login (desktop/mobile)
async function waitForLoginForm(page) {
  const selectors = [
    'input[name="username"]',
    'input[name="password"]',
    // mobile às vezes usa outros atributos, mas costuma manter name=
    'form input[type="text"]',
    'form input[type="password"]',
  ];
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    for (const s of selectors) {
      const el = await page.$(s).catch(() => null);
      if (el) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

(async () => {
  console.log('[IG COOKIE] Chromium HEADLESS =', HEADLESS);
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
  });
  const page = await ctx.newPage();

  try {
    // 1) tenta desktop
    console.log('[IG COOKIE] Abrindo login desktop…');
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1500);
    await acceptCookies(page);

    let hasForm = await waitForLoginForm(page);
    if (!hasForm) {
      // 2) tenta mobile – geralmente menos “fresco”
      console.log('[IG COOKIE] Form não apareceu. Tentando mobile…');
      await page.goto('https://m.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(1500);
      await acceptCookies(page);
      hasForm = await waitForLoginForm(page);
    }
    if (!hasForm) throw new Error('Formulário de login não encontrado (pode ser challenge/AB test).');

    // preenche – tenta os names clássicos primeiro
    const uSel = (await page.$('input[name="username"]')) ? 'input[name="username"]' : 'form input[type="text"]';
    const pSel = (await page.$('input[name="password"]')) ? 'input[name="password"]' : 'form input[type="password"]';

    await page.fill(uSel, IG_USER, { timeout: 30000 });
    await page.fill(pSel, IG_PASS, { timeout: 30000 });

    // botão submit – várias variações
    const submitCandidates = [
      'button[type="submit"]',
      'form button:has-text("Log in")',
      'form button:has-text("Entrar")',
      'text=/Log in|Entrar/i >> button',
    ];
    let clicked = false;
    for (const sel of submitCandidates) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) { await btn.click({ timeout: 30000 }).catch(()=>{}); clicked = true; break; }
    }
    if (!clicked) {
      // tecla Enter se não achou botão
      await page.keyboard.press('Enter');
    }

    // espera rede se acalmar
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(()=>{});

    // detecta 2FA
    const twoFA = await page.$('input[name="verificationCode"], input[name="security_code"], input[name="code"], input[autocomplete="one-time-code"]').catch(()=>null);
    if (twoFA) {
      throw new Error('2FA detectado. Rode com HEADLESS=false e use xvfb-run para completar o desafio, ou copie sessionid manualmente do seu navegador.');
    }

    // às vezes só gera session após visitar / (home)
    await page.waitForTimeout(EXTRA_WAIT_MS);
    const cookies1 = await ctx.cookies();
    let igCookies = cookies1.filter(c => /instagram\.com$/i.test(c.domain || ''));
    if (!igCookies.find(c => c.name === 'sessionid')) {
      console.log('[IG COOKIE] sessionid não vista; visitando home…');
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(EXTRA_WAIT_MS);
      const cookies2 = await ctx.cookies();
      igCookies = cookies2.filter(c => /instagram\.com$/i.test(c.domain || ''));
    }

    const sess = igCookies.find(c => c.name === 'sessionid');
    if (!sess?.value) throw new Error('Não foi possível capturar "sessionid" (possível bloqueio/challenge).');

    // salva Netscape
    const netscape = toNetscapeCookieLines(igCookies);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, netscape, 'utf8');
    try { fs.chmodSync(OUT, 0o600); } catch {}

    console.log('[IG COOKIE] OK! Cookies salvos em:', OUT);
    console.log('Ex.: yt-dlp --cookies', OUT, '-S ext:mp4:m4v --no-playlist -o test.%(ext)s "https://www.instagram.com/reel/XXXXXXXX/"');
  } catch (e) {
    console.error('[IG COOKIE][ERRO]', e.message || e);

    // artefatos de debug
    try {
      const shot = '/root/insta-bot/ig_login_fail.png';
      const html = '/root/insta-bot/ig_login_fail.html';
      await page.screenshot({ path: shot, fullPage: true }).catch(()=>{});
      fs.writeFileSync(html, await page.content());
      console.error('[IG COOKIE] Debug salvo:', shot, html);
    } catch {}

    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
