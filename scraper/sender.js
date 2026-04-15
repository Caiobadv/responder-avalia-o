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
    .replace(/\{\{negocio\}\}/g, data.negocio || '')
    .replace(/\{\{negocios\}\}/g, data.negocios || '');
}

// Normaliza um telefone para uso como chave (só dígitos)
function normalizePhone(phone) {
  if (!phone) return '';
  let clean = phone.replace(/\D/g, '');
  if (clean.length === 0) return '';
  if (!clean.startsWith('55') && clean.length >= 10) clean = '55' + clean;
  return clean;
}

// Verifica se o número é FIXO (não recebe WhatsApp)
// No Brasil: celular sempre começa com 9 depois do DDD.
// Se começa com 2, 3, 4 ou 5, é fixo.
function isLandline(phone) {
  const clean = (phone || '').replace(/\D/g, '');
  if (!clean) return false;

  let local = clean;
  // Remove 55 (país) se tiver
  if (local.startsWith('55') && local.length > 10) {
    local = local.substring(2);
  }

  // Agora deve ser DDD(2) + número(8 ou 9 dígitos)
  // Celular: 11 dígitos (DDD + 9 + 8) e primeiro do número é 9
  // Fixo: 10 dígitos (DDD + 8) OU primeiro dígito após DDD não é 9
  if (local.length === 10) {
    // 10 dígitos = sem o 9 → fixo
    return true;
  }
  if (local.length === 11) {
    // 11 dígitos: se o 3º dígito (primeiro depois do DDD) não é 9 → fixo
    return local[2] !== '9';
  }
  return false;
}

// Normaliza um email para uso como chave
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// Gera string amigável com a lista de negócios (ex: "Hotel A, Hotel B e Hotel C")
function formatBusinessList(names) {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return 'seus estabelecimentos';
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} e ${unique[1]}`;
  return unique.slice(0, -1).join(', ') + ' e ' + unique[unique.length - 1];
}

// Agrupa rows por contato (WhatsApp e email)
// Retorna lista de { channel: 'whatsapp'|'email', contact: string, rows: [] }
// Filtra números fixos — esses vão para email ou Instagram manual
function groupByContact(rows) {
  const whatsappGroups = new Map(); // phone -> [rows]
  const emailGroups = new Map();    // email -> [rows]
  const semCanal = [];              // sem WhatsApp celular nem email

  for (const row of rows) {
    let whatsappValido = null;

    // Tenta pegar primeiro WhatsApp que NÃO seja fixo
    if (row.WhatsApp) {
      const phones = row.WhatsApp.split(';').map(p => normalizePhone(p)).filter(Boolean);
      whatsappValido = phones.find(p => !isLandline(p));
    }

    if (whatsappValido) {
      if (!whatsappGroups.has(whatsappValido)) whatsappGroups.set(whatsappValido, []);
      whatsappGroups.get(whatsappValido).push(row);
      continue;
    }

    // Sem WhatsApp celular válido → tenta email
    if (row.Email) {
      const emails = row.Email.split(';').map(e => normalizeEmail(e)).filter(Boolean);
      const primary = emails[0];
      if (primary) {
        if (!emailGroups.has(primary)) emailGroups.set(primary, []);
        emailGroups.get(primary).push(row);
        continue;
      }
    }

    // Nem WhatsApp válido nem email → vai pro Instagram manual / sem canal
    semCanal.push(row);
  }

  const groups = [];
  for (const [phone, rs] of whatsappGroups) {
    groups.push({ channel: 'whatsapp', contact: phone, rows: rs });
  }
  for (const [email, rs] of emailGroups) {
    groups.push({ channel: 'email', contact: email, rows: rs });
  }

  return { groups, semCanal };
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

// Envia mensagem usando a MESMA página principal (não abre novas abas)
async function sendWhatsApp(page, phone, message) {
  try {
    // Limpa o número (só dígitos, com 55)
    let cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone.startsWith('55')) cleanPhone = '55' + cleanPhone;

    const encodedMsg = encodeURIComponent(message);
    const url = `https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encodedMsg}`;

    // Navega a página principal para a URL do envio (não abre nova aba)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Espera o chat carregar (botão de enviar aparece)
    const sendButton = page.locator('button[aria-label="Enviar"], button[aria-label="Send"], span[data-icon="send"]').first();

    // Tenta esperar até 30s pelo botão de enviar
    let ready = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(2000);

      // Verifica se apareceu mensagem de número inválido
      const invalid = await page.locator('text=/número de telefone .* inválido|phone number.*invalid|não pode ser encontrado|could not be found/i')
        .isVisible({ timeout: 500 }).catch(() => false);
      if (invalid) {
        log(`   NUMERO INVALIDO: ${cleanPhone}`);
        // Volta para a tela principal
        await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
        return 'numero_invalido';
      }

      // Verifica popup de "WhatsApp aberto em outra janela"
      const usarAqui = page.locator('button:has-text("Usar nesta janela"), button:has-text("Use Here")').first();
      if (await usarAqui.isVisible({ timeout: 500 }).catch(() => false)) {
        await usarAqui.click();
        await sleep(2000);
        continue;
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
      return 'timeout';
    }

    // Clica no botão de enviar
    await sendButton.click();
    await sleep(3000, 5000);

    // Verifica se a mensagem foi enviada (aparece check)
    log(`   WhatsApp ENVIADO para ${cleanPhone}`);
    return 'enviado_whatsapp';

  } catch (err) {
    log(`   ERRO WhatsApp para ${phone}: ${err.message}`);
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

  // AGRUPA por contato — negócios que compartilham WhatsApp/email recebem UMA mensagem só
  // Filtra telefones fixos (celulares só começam com 9 depois do DDD)
  const { groups: grupos, semCanal } = groupByContact(comCanal);

  const grupsWhats = grupos.filter(g => g.channel === 'whatsapp');
  const grupsEmail = grupos.filter(g => g.channel === 'email');

  log(`Total: ${rows.length} prospects`);
  log(`Pendentes: ${pendentes.length}`);
  log(`Com canal de contato: ${comCanal.length}`);
  log(`Grupos WhatsApp (celular): ${grupsWhats.length}`);
  log(`Grupos Email (fixo/sem celular): ${grupsEmail.length}`);
  log(`Sem canal viável (só Instagram manual): ${semCanal.length}`);
  log(`Limite hoje: ${config.MAX_ENVIOS_DIA} envios\n`);

  // Marca os sem canal como tal no CSV
  for (const row of semCanal) {
    if (row.Instagram) {
      row.Status_Envio = 'instagram_manual';
    } else {
      row.Status_Envio = 'sem_canal_valido';
    }
  }
  if (semCanal.length > 0) {
    writeCSV(csvFile, headers, rows);
    log(`${semCanal.length} prospects marcados para Instagram manual/sem canal\n`);
  }

  // Mostra grupos com múltiplos negócios (redes)
  const multis = grupos.filter(g => g.rows.length > 1);
  if (multis.length > 0) {
    log(`Grupos com 2+ negócios (mensagem única para cada):`);
    for (const g of multis.slice(0, 5)) {
      const names = g.rows.map(r => r.Nome).slice(0, 3).join(', ');
      log(`  - ${g.contact}: ${g.rows.length} negócios (${names}${g.rows.length > 3 ? '...' : ''})`);
    }
    if (multis.length > 5) log(`  ... e mais ${multis.length - 5} grupos`);
    log('');
  }

  if (grupos.length === 0) {
    log('Nenhum grupo pendente com canal de contato. Nada a enviar.');
    process.exit(0);
  }

  const aEnviar = grupos.slice(0, config.MAX_ENVIOS_DIA);
  log(`\nEnviando para: ${aEnviar.length} grupos (${aEnviar.reduce((sum, g) => sum + g.rows.length, 0)} prospects cobertos)\n`);

  // ── Setup WhatsApp Web ──
  let whatsappContext = null;
  let whatsappPage = null;
  const temWhatsApp = aEnviar.some(g => g.channel === 'whatsapp');

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

    // Fecha todas as páginas extras que o Playwright possa ter aberto,
    // mantém apenas uma (para evitar o popup "WhatsApp aberto em outra janela")
    const allPages = whatsappContext.pages();
    for (let i = 1; i < allPages.length; i++) {
      try { await allPages[i].close(); } catch {}
    }

    // Abre WhatsApp Web e espera login — esta é a página que será reutilizada
    whatsappPage = whatsappContext.pages()[0] || await whatsappContext.newPage();
    await whatsappPage.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

    // Espera até o usuário logar (chats aparecem)
    log('Aguardando login no WhatsApp Web...');
    for (let i = 0; i < 60; i++) {
      const loggedIn = await whatsappPage.locator('[data-icon="chat"], [aria-label="Lista de conversas"], [aria-label="Chat list"]')
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
  const temEmail = aEnviar.some(g => g.channel === 'email') && config.SMTP_USER && config.SMTP_PASS;

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
    const grupo = aEnviar[i];
    const nomes = grupo.rows.map(r => r.Nome || 'sem nome');
    const negocioStr = formatBusinessList(nomes);
    const isMulti = grupo.rows.length > 1;

    log(`[${i + 1}/${aEnviar.length}] ${grupo.channel.toUpperCase()}: ${grupo.contact}`);
    if (isMulti) {
      log(`   Grupo com ${grupo.rows.length} negócios: ${negocioStr}`);
    } else {
      log(`   Negócio: ${negocioStr}`);
    }

    const templateData = {
      nome: '',
      negocio: nomes[0], // Primeiro nome para template singular
      negocios: negocioStr, // Lista formatada para template múltiplo
    };

    let status = 'nao_enviado';

    // WhatsApp
    if (grupo.channel === 'whatsapp' && whatsappPage) {
      const template = isMulti ? config.MENSAGEM_WHATSAPP_MULTI : config.MENSAGEM_WHATSAPP;
      const msg = fillTemplate(template, templateData);

      status = await sendWhatsApp(whatsappPage, grupo.contact, msg);

      // Delay entre WhatsApps
      if (i < aEnviar.length - 1) {
        const delay = config.DELAY_WHATSAPP_MS + Math.random() * 60000;
        log(`   Aguardando ${Math.round(delay / 1000)}s antes do próximo...`);
        await sleep(delay);
      }
    }

    // Email
    if (grupo.channel === 'email' && transporter) {
      const subjectTpl = isMulti ? config.ASSUNTO_EMAIL_MULTI : config.ASSUNTO_EMAIL;
      const bodyTpl = isMulti ? config.CORPO_EMAIL_MULTI : config.CORPO_EMAIL;
      const subject = fillTemplate(subjectTpl, templateData);
      const body = fillTemplate(bodyTpl, templateData);

      status = await sendEmail(transporter, grupo.contact, subject, body);

      if (i < aEnviar.length - 1) {
        await sleep(config.DELAY_EMAIL_MS);
      }
    }

    // Atualiza status em TODAS as rows do grupo (todas recebem o mesmo status)
    const sucesso = status.includes('enviado');
    if (sucesso) enviados++;
    else erros++;

    for (const row of grupo.rows) {
      row.Status_Envio = status;
      // Marca rows duplicados como "enviado_em_grupo" se não forem o primeiro
      if (grupo.rows.indexOf(row) > 0 && sucesso) {
        row.Status_Envio = `enviado_em_grupo (${grupo.channel}: ${grupo.contact})`;
      }
    }

    // Instagram manual — loga para todos os negócios do grupo (se tiver)
    for (const row of grupo.rows) {
      if (row.Instagram) {
        const handles = row.Instagram.split(';').map(h => h.trim()).filter(Boolean);
        for (const handle of handles) {
          log(`   IG manual: ${row.Nome} -> https://instagram.com/${handle.replace('@', '')}`);
        }
      }
    }

    // Salva CSV atualizado (incremental)
    writeCSV(csvFile, headers, rows);
  }

  // ── Fechamento ──
  if (whatsappContext) {
    await whatsappContext.close();
  }

  // Conta Instagram pendente manual entre os rows dos grupos enviados
  const instaManual = aEnviar.reduce((sum, g) => {
    return sum + g.rows.filter(r => r.Instagram).length;
  }, 0);

  // Conta prospects individuais cobertos (soma dos tamanhos dos grupos)
  const prospectsCobertos = aEnviar.reduce((sum, g) => sum + g.rows.length, 0);

  log('\n══════════════════════════════════════════');
  log('  ENVIO CONCLUIDO!');
  log(`  Grupos enviados: ${enviados} / ${aEnviar.length}`);
  log(`  Prospects cobertos: ${prospectsCobertos} (deduplicados)`);
  log(`  Erros: ${erros}`);
  log(`  Instagram (manual): ${instaManual}`);
  log(`  Log completo: ${LOG_FILE}`);
  log('══════════════════════════════════════════');
}

main().catch(err => {
  console.error('\nErro fatal:', err.message);
  process.exit(1);
});
