#!/usr/bin/env node

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ╔══════════════════════════════════════════════════════════════╗
// ║   ENVIO AUTOMÁTICO DE MENSAGENS                              ║
// ║   WhatsApp Web + Email para prospects enriquecidos            ║
// ╚══════════════════════════════════════════════════════════════╝

const OUTPUT_DIR = path.join(__dirname, 'output');
const LOG_FILE = path.join(OUTPUT_DIR, 'envios.log');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  const time = new Date().toLocaleTimeString('pt-BR');
  const line = `[${time}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

function fillTemplate(template, data) {
  return template
    .replace(/\{\{nome\}\}/g, data.nome || '')
    .replace(/\{\{negocio\}\}/g, data.negocio || '');
}

// ── CSV PARSING ──────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(content) {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function escapeCSV(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes(';')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCSV(file, headers, rows) {
  const lines = [headers.map(escapeCSV).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCSV(row[h])).join(','));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

// ── WHATSAPP WEB ─────────────────────────────────────────────────

async function sendWhatsApp(context, phone, message) {
  const page = await context.newPage();

  try {
    // Limpa o número (só dígitos, com 55)
    let cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone.startsWith('55')) cleanPhone = '55' + cleanPhone;

    const encodedMsg = encodeURIComponent(message);
    const url = `https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encodedMsg}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Espera o chat carregar (botão de enviar aparece)
    const sendButton = page.locator('button[aria-label="Enviar"], button[aria-label="Send"], span[data-icon="send"]').first();

    // Tenta esperar até 30s pelo botão de enviar
    let ready = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(2000);

      // Verifica se apareceu mensagem de número inválido
      const invalid = await page.locator('text=/número de telefone .* inválido|phone number.*invalid/i')
        .isVisible({ timeout: 500 }).catch(() => false);
      if (invalid) {
        log(`   NUMERO INVALIDO: ${cleanPhone}`);
        await page.close();
        return 'numero_invalido';
      }

      // Verifica se o botão de enviar está visível
      const visible = await sendButton.isVisible({ timeout: 500 }).catch(() => false);
      if (visible) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      log(`   TIMEOUT esperando chat carregar para ${cleanPhone}`);
      await page.close();
      return 'timeout';
    }

    // Clica no botão de enviar
    await sendButton.click();
    await sleep(3000, 5000);

    // Verifica se a mensagem foi enviada (aparece check)
    log(`   WhatsApp ENVIADO para ${cleanPhone}`);
    await page.close();
    return 'enviado_whatsapp';

  } catch (err) {
    log(`   ERRO WhatsApp para ${phone}: ${err.message}`);
    try { await page.close(); } catch {}
    return 'erro_whatsapp';
  }
}

// ── EMAIL ────────────────────────────────────────────────────────

async function sendEmail(transporter, to, subject, body) {
  try {
    await transporter.sendMail({
      from: `"${config.SMTP_FROM_NAME}" <${config.SMTP_USER}>`,
      to,
      subject,
      text: body,
    });
    log(`   Email ENVIADO para ${to}`);
    return 'enviado_email';
  } catch (err) {
    log(`   ERRO email para ${to}: ${err.message}`);
    return 'erro_email';
  }
}

// ── MAIN ─────────────────────────────────────────────────────────

async function main() {
  // Encontra o CSV enriquecido mais recente
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.includes('ENRIQUECIDO') && f.endsWith('.csv'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error('Nenhum CSV enriquecido encontrado.');
    console.error('Rode primeiro: node enrich.js');
    process.exit(1);
  }

  const csvFile = path.join(OUTPUT_DIR, files[0]);
  log(`\nLendo: ${files[0]}`);

  const content = fs.readFileSync(csvFile, 'utf8');
  const { headers, rows } = parseCSV(content);

  // Filtra prospects que ainda não receberam mensagem
  const pendentes = rows.filter(r => !r.Status_Envio || r.Status_Envio === '');
  const comCanal = pendentes.filter(r => r.WhatsApp || r.Email);

  log(`Total: ${rows.length} prospects`);
  log(`Pendentes: ${pendentes.length}`);
  log(`Com canal de contato: ${comCanal.length}`);
  log(`Limite hoje: ${config.MAX_ENVIOS_DIA}`);

  if (comCanal.length === 0) {
    log('Nenhum prospect pendente com canal de contato. Nada a enviar.');
    process.exit(0);
  }

  const aEnviar = comCanal.slice(0, config.MAX_ENVIOS_DIA);
  log(`Enviando para: ${aEnviar.length} prospects\n`);

  // ── Setup WhatsApp Web ──
  let whatsappContext = null;
  const temWhatsApp = aEnviar.some(r => r.WhatsApp);

  if (temWhatsApp) {
    log('Abrindo WhatsApp Web...');
    log('>>> ESCANEIE O QR CODE NO NAVEGADOR (apenas na primeira vez) <<<\n');

    const sessionDir = path.join(__dirname, config.WHATSAPP_SESSION_DIR);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const browser = await chromium.launchPersistentContext(sessionDir, {
      headless: false,
      args: ['--lang=pt-BR', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    whatsappContext = browser;

    // Abre WhatsApp Web e espera login
    const mainPage = whatsappContext.pages()[0] || await whatsappContext.newPage();
    await mainPage.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

    // Espera até o usuário logar (chats aparecem)
    log('Aguardando login no WhatsApp Web...');
    for (let i = 0; i < 60; i++) {
      const loggedIn = await mainPage.locator('[data-icon="chat"], [aria-label="Lista de conversas"], [aria-label="Chat list"]')
        .first().isVisible({ timeout: 2000 }).catch(() => false);
      if (loggedIn) {
        log('WhatsApp Web conectado!\n');
        break;
      }
      if (i === 59) {
        log('TIMEOUT: Não foi possível conectar ao WhatsApp Web.');
        log('Continuando apenas com email...');
      }
    }
  }

  // ── Setup Email ──
  let transporter = null;
  const temEmail = aEnviar.some(r => r.Email) && config.SMTP_USER && config.SMTP_PASS;

  if (temEmail) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: false,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });

    // Testa conexão
    try {
      await transporter.verify();
      log('Conexão SMTP OK\n');
    } catch (err) {
      log(`ERRO SMTP: ${err.message}`);
      log('Emails não serão enviados. Verifique config.js\n');
      transporter = null;
    }
  }

  // ── Envio ──
  let enviados = 0;
  let erros = 0;

  for (let i = 0; i < aEnviar.length; i++) {
    const row = aEnviar[i];
    const negocio = row.Nome || row.nome || 'seu negócio';
    const templateData = { nome: '', negocio };

    log(`[${i + 1}/${aEnviar.length}] ${negocio}`);

    const statuses = [];

    // Tenta WhatsApp primeiro
    if (row.WhatsApp && whatsappContext) {
      const phones = row.WhatsApp.split(';').map(p => p.trim()).filter(Boolean);
      const msg = fillTemplate(config.MENSAGEM_WHATSAPP, templateData);

      for (const phone of phones) {
        const status = await sendWhatsApp(whatsappContext, phone, msg);
        statuses.push(status);
        if (status === 'enviado_whatsapp') break; // Um envio bem-sucedido basta
      }

      // Delay entre WhatsApps
      if (i < aEnviar.length - 1) {
        const delay = config.DELAY_WHATSAPP_MS + Math.random() * 60000;
        log(`   Aguardando ${Math.round(delay / 1000)}s antes do próximo...`);
        await sleep(delay);
      }
    }

    // Tenta email
    if (row.Email && transporter) {
      const emails = row.Email.split(';').map(e => e.trim()).filter(Boolean);
      const subject = fillTemplate(config.ASSUNTO_EMAIL, templateData);
      const body = fillTemplate(config.CORPO_EMAIL, templateData);

      for (const email of emails) {
        const status = await sendEmail(transporter, email, subject, body);
        statuses.push(status);
        if (status === 'enviado_email') break;
      }

      await sleep(config.DELAY_EMAIL_MS);
    }

    // Instagram — apenas loga
    if (row.Instagram) {
      const handles = row.Instagram.split(';').map(h => h.trim()).filter(Boolean);
      for (const handle of handles) {
        log(`   Instagram ${handle} — abordar MANUALMENTE: https://instagram.com/${handle.replace('@', '')}`);
      }
      statuses.push('instagram_manual');
    }

    // Sem nenhum canal
    if (statuses.length === 0) {
      log(`   Nenhum canal de contato disponível`);
      statuses.push('sem_canal');
    }

    // Atualiza status no CSV
    row.Status_Envio = statuses.join('; ');
    const sucesso = statuses.some(s => s.includes('enviado'));
    if (sucesso) enviados++;
    else erros++;

    // Salva CSV atualizado (incremental)
    writeCSV(csvFile, headers, rows);
  }

  // ── Fechamento ──
  if (whatsappContext) {
    await whatsappContext.close();
  }

  log('\n══════════════════════════════════════════');
  log('  ENVIO CONCLUIDO!');
  log(`  Enviados com sucesso: ${enviados}`);
  log(`  Erros: ${erros}`);
  log(`  Instagram (manual): ${aEnviar.filter(r => r.Instagram).length}`);
  log(`  Log completo: ${LOG_FILE}`);
  log('══════════════════════════════════════════');
}

main().catch(err => {
  console.error('\nErro fatal:', err.message);
  process.exit(1);
});
