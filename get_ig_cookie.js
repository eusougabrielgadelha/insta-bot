// /root/insta-bot/get_ig_cookie.js
import { chromium } from '@playwright/test';
import fs from 'fs';
import * as path from 'node:path';

const IG_USER = process.env.IG_USER || '';
const IG_PASS = process.env.IG_PASS || '';
const OUT = process.env.OUT || '/root/insta-bot/cookies.txt';
const HEADLESS = (process.env.HEADLESS ?? 'true').toLowerCase() !== 'false'; // default: true
const EXTRA_WAIT_MS = Number(process.env.EXTRA_WAIT_MS || 4000);
const TIMEOUT = Number(process.env.TIMEOUT || 120000);
const NAV_RETRIES = Number(process.env.NAV_RETRIES || 3);

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

async function acceptCookies(page) {
  const candidates = [
    'button:has-text("Allow all cookies")',
    'button:has-text("Only allow essential cookies")',
    'button:has-text("Permitir todos os cookies")',
    'button:has-text("Permitir apenas cookies essenciais")',
    'button:has-text("Accept")',
    'button:has-text("Aceitar")',
    '[role="dialog"] button:has-text("Accept")',
    '[role="dialog"] button:has-text("Aceitar")',
    'text=/cookies/i >> .. >> button',
  ];
  for (const sel of candidates) {
    try {
      const b = await page.$(sel);
      if (b) { await b.click({ timeout: 1500 }); await page.waitForTimeout(400); }
    } catch {}
  }
}

async function waitForAnySelector(page, sels, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const s of sels) {
      const el = await page.$(s).catch(() => null);
      if (el) return s;
    }
    await page.waitForTimeout(350);
  }
  return null;
}

async function fillLogin(page, user, pass) {
  const userSels = [
    'input[name="username"]',
    'input[placeholder*="username" i]',
    'input[placeholder*="e-mail" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="telefone" i]',
    'input[placeholder*="phone" i]',
    'input[type="text"]',
  ];
  const passSels = [
    'input[name="password"]',
    'input[placeholder*="senha" i]',
    'input[placeholder*="password" i]',
    'input[type="password"]',
  ];
  const userSel = await waitForAnySelector(page, userSels, 30000);
  const passSel = await waitForAnySelector(page, passSels, 30000);
  if (!userSel || !passSel) throw new Error('Formulário não visível (user/pass).');

  await page.fill(userSel, user, { timeout: 20000 });
  await page.fill(passSel, pass, { timeout: 20000 });

  // Submit
  const submitCandidates = [
    'button[type="submit"]',
    'form button:has-text("Log in")',
    'form button:has-text("Entrar")',
    'text=/Log in|Entrar/i >> button',
  ];
  let clicked = false;
  for (const sel of submitCandidates) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click({ timeout: 20000 }).catch(()=>{}); clicked = true; break; }
  }
  if (!clicked) await page.keyboard.press('Enter');
}

// navegação com retry para contornar ERR_HTTP_RESPONSE_CODE_FAILURE (4xx/5xx)
async function gotoWithRetries(page, url, label) {
  let lastErr;
  for (let i = 0; i < NAV_RETRIES; i++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      // Se a navegação falhar sem response, Playwright lança; se vier response 4xx/5xx, trate aqui
      if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()} em ${label || url}`);
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1000 + i * 1000);
    }
  }
  throw lastErr || new Error(`Falha ao navegar para ${url}`);
}

(async () => {
  console.log('[IG COOKIE] HEADLESS =', HEADLESS);
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });
  const page = await ctx.newPage();

  try {
    // 1) Desktop com retry
    console.log('[IG COOKIE] Abrindo login (desktop)…');
    await gotoWithRetries(page, 'https://www.instagram.com/accounts/login/', 'login-desktop');
    await page.waitForTimeout(1200);
    await acceptCookies(page);

    // Se não encontrar rapidamente, tenta mobile
    let hasUsername = await waitForAnySelector(page, ['input[name="username"]', 'input[type="text"]'], 8000);
    if (!hasUsername) {
      console.log('[IG COOKIE] Trocando para versão mobile…');
      await gotoWithRetries(page, 'https://m.instagram.com/accounts/login/', 'login-mobile');
      await page.waitForTimeout(1200);
      await acceptCookies(page);
    }

    // Preenche e envia
    await fillLogin(page, IG_USER, IG_PASS);

    // Espera a rede acalmar
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(()=>{});
    await page.waitForTimeout(EXTRA_WAIT_MS);

    // 2FA?
    const twoFA = await page.$('input[name="verificationCode"], input[name="security_code"], input[name="code"], input[autocomplete="one-time-code"]').catch(()=>null);
    if (twoFA) throw new Error('2FA detectado. Rode com HEADLESS=false + xvfb-run e complete o desafio, ou pegue sessionid manualmente.');

    // às vezes só gera session após visitar a home
    let cookies = await ctx.cookies();
    let igCookies = cookies.filter(c => /instagram\.com$/i.test(c.domain || ''));
    if (!igCookies.find(c => c.name === 'sessionid')) {
      console.log('[IG COOKIE] sessionid não vista; visitando home…');
      await gotoWithRetries(page, 'https://www.instagram.com/', 'home');
      await page.waitForTimeout(EXTRA_WAIT_MS);
      cookies = await ctx.cookies();
      igCookies = cookies.filter(c => /instagram\.com$/i.test(c.domain || ''));
    }

    const sess = igCookies.find(c => c.name === 'sessionid');
    if (!sess?.value) throw new Error('Não foi possível capturar "sessionid" (possível bloqueio/challenge).');

    const netscape = toNetscapeCookieLines(igCookies);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, netscape, 'utf8');
    try { fs.chmodSync(OUT, 0o600); } catch {}

    console.log('[IG COOKIE] OK! Cookies salvos em:', OUT);
    console.log('Ex.: yt-dlp --cookies', OUT, '-S ext:mp4:m4v --no-playlist -o test.%(ext)s "https://www.instagram.com/reel/XXXXXXXX/"');
  } catch (e) {
    console.error('[IG COOKIE][ERRO]', e.message || e);
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
