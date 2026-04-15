#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ╔══════════════════════════════════════════════════════════════╗
// ║   ENRIQUECIMENTO DE PROSPECTS                                ║
// ║   Extrai email, Instagram e WhatsApp de cada prospect        ║
// ╚══════════════════════════════════════════════════════════════╝

const OUTPUT_DIR = path.join(__dirname, 'output');

function sleep(min = 2000, max = 4000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function log(msg) {
  const time = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${time}] ${msg}`);
}

// ── CSV PARSING ──────────────────────────────────────────────────

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

// ── EXTRAÇÃO DE CONTATOS ─────────────────────────────────────────

// Extrai emails, Instagram e WhatsApp de uma página web
async function extractFromWebsite(page, url) {
  const result = { emails: [], instagrams: [], whatsapps: [] };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000, 3000);

    const data = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      const bodyHtml = document.body ? document.body.innerHTML : '';

      // Emails via regex no texto e HTML
      const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      const emailsFromText = bodyText.match(emailRegex) || [];
      const emailsFromHtml = bodyHtml.match(emailRegex) || [];
      const allEmails = [...new Set([...emailsFromText, ...emailsFromHtml])];

      // Filtra emails que são imagens, scripts ou falsos positivos
      const validEmails = allEmails.filter(e => {
        const lower = e.toLowerCase();
        return !lower.includes('.png') && !lower.includes('.jpg') &&
               !lower.includes('.gif') && !lower.includes('.svg') &&
               !lower.includes('sentry') && !lower.includes('webpack') &&
               !lower.includes('example.com') && !lower.includes('email.com') &&
               !lower.endsWith('.js') && !lower.endsWith('.css');
      });

      // Instagram via links
      const instaRegex = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?/g;
      const instaMatches = bodyHtml.match(instaRegex) || [];
      const instagrams = [...new Set(instaMatches.map(url => {
        const match = url.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
        return match ? '@' + match[1] : null;
      }).filter(Boolean).filter(handle =>
        !['@p', '@reel', '@stories', '@explore', '@accounts', '@about', '@legal', '@developer'].includes(handle)
      ))];

      // WhatsApp via links wa.me ou api.whatsapp.com
      const waRegex = /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?([\d+]+)/g;
      const waMatches = bodyHtml.match(waRegex) || [];
      const whatsapps = [...new Set(waMatches.map(url => {
        const match = url.match(/([\d+]{10,})/);
        return match ? match[1] : null;
      }).filter(Boolean))];

      // Também busca links href com wa.me
      const allLinks = document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp"]');
      for (const link of allLinks) {
        const href = link.href || '';
        const numMatch = href.match(/(\d{10,15})/);
        if (numMatch && !whatsapps.includes(numMatch[1])) {
          whatsapps.push(numMatch[1]);
        }
      }

      return { emails: validEmails, instagrams, whatsapps };
    });

    result.emails = data.emails;
    result.instagrams = data.instagrams;
    result.whatsapps = data.whatsapps;
  } catch (err) {
    log(`      Erro ao acessar ${url}: ${err.message}`);
  }

  return result;
}

// Extrai redes sociais da página do Google Maps
async function extractFromGoogleMaps(page, mapsUrl) {
  const result = { instagrams: [], websites: [], phones: [] };

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2500, 3500);

    const data = await page.evaluate(() => {
      const instagrams = [];
      const websites = [];
      const phones = [];

      // Busca todos os links e botões com aria-label
      const elements = document.querySelectorAll('a[href], button[aria-label]');
      for (const el of elements) {
        const href = el.href || '';
        const label = (el.getAttribute('aria-label') || '').toLowerCase();

        // Instagram
        if (href.includes('instagram.com/')) {
          const match = href.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
          if (match) {
            const handle = '@' + match[1];
            if (!['@p', '@reel', '@stories', '@explore'].includes(handle)) {
              instagrams.push(handle);
            }
          }
        }

        // Website
        if ((label.includes('site') || label.includes('website')) && href && !href.includes('google.com')) {
          websites.push(href);
        }

        // Telefone
        if (label.includes('telefone') || label.includes('phone') || href.startsWith('tel:')) {
          const num = href.startsWith('tel:')
            ? href.replace('tel:', '').trim()
            : (el.getAttribute('aria-label') || '').match(/[\d\s\(\)\-\+]{8,}/)?.[0]?.trim();
          if (num) phones.push(num);
        }
      }

      return {
        instagrams: [...new Set(instagrams)],
        websites: [...new Set(websites)],
        phones: [...new Set(phones)]
      };
    });

    result.instagrams = data.instagrams;
    result.websites = data.websites;
    result.phones = data.phones;
  } catch (err) {
    log(`      Erro no Google Maps: ${err.message}`);
  }

  return result;
}

// ── ENRIQUECIMENTO DE UMA LINHA ──────────────────────────────────

async function enrichRow(page, row, idx, total) {
  const nome = row.Nome || 'sem nome';
  log(`[${idx}/${total}] Enriquecendo: ${nome}...`);

  let allEmails = [];
  let allInstagrams = [];
  let allWhatsapps = [];

  // 1. Extrair do Google Maps
  const mapsUrl = row['Google Maps'] || row['GoogleMaps'] || '';
  if (mapsUrl) {
    const mapsData = await extractFromGoogleMaps(page, mapsUrl);
    allInstagrams.push(...mapsData.instagrams);

    // Se achou websites no Maps, visita cada um (máximo 1 para agilizar)
    const websitesToVisit = mapsData.websites.slice(0, 1);
    for (const website of websitesToVisit) {
      try {
        const siteData = await extractFromWebsite(page, website);
        allEmails.push(...siteData.emails);
        allInstagrams.push(...siteData.instagrams);
        allWhatsapps.push(...siteData.whatsapps);
      } catch (err) {
        log(`      Falha website ${website}: ${err.message.slice(0, 50)}`);
      }
      await sleep(800, 1500);
    }

    // Se tem telefone do Maps, usa como WhatsApp
    if (mapsData.phones.length > 0 && allWhatsapps.length === 0) {
      const phone = mapsData.phones[0].replace(/\D/g, '');
      if (phone.length >= 10) {
        allWhatsapps.push(phone.startsWith('55') ? phone : '55' + phone);
      }
    }
  }

  // 2. Se tem website na coluna original do CSV, visita também
  const csvWebsite = row.Website || row.website || '';
  if (csvWebsite && !csvWebsite.includes('google.com') && allEmails.length === 0) {
    const url = csvWebsite.startsWith('http') ? csvWebsite : 'https://' + csvWebsite;
    try {
      const siteData = await extractFromWebsite(page, url);
      allEmails.push(...siteData.emails);
      allInstagrams.push(...siteData.instagrams);
      allWhatsapps.push(...siteData.whatsapps);
    } catch (err) {
      log(`      Falha website CSV ${url}: ${err.message.slice(0, 50)}`);
    }
  }

  // 3. Se tem telefone na coluna original e nenhum WhatsApp encontrado
  const csvPhone = row.Telefone || row.telefone || '';
  if (csvPhone && allWhatsapps.length === 0) {
    const phone = csvPhone.replace(/\D/g, '');
    if (phone.length >= 10) {
      allWhatsapps.push(phone.startsWith('55') ? phone : '55' + phone);
    }
  }

  // Deduplica e salva
  row.Email = [...new Set(allEmails)].join('; ');
  row.Instagram = [...new Set(allInstagrams)].join('; ');
  row.WhatsApp = [...new Set(allWhatsapps)].join('; ');
  row.Status_Envio = row.Status_Envio || '';
  row.Enriquecido = 'sim'; // Marca como processado independentemente do resultado

  const found = [];
  if (row.Email) found.push(`email`);
  if (row.Instagram) found.push(`ig`);
  if (row.WhatsApp) found.push(`wpp`);
  log(`   [${idx}] ${nome} -> ${found.length > 0 ? found.join('+') : 'nada'}`);
}

// ── MAIN ─────────────────────────────────────────────────────────

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);

async function main() {
  // Encontra o CSV mais recente
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('prospects-') && f.endsWith('.csv') && !f.includes('ENRIQUECIDO'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error('Nenhum CSV de prospects encontrado em scraper/output/');
    console.error('Rode primeiro: node scraper.js');
    process.exit(1);
  }

  const inputFile = path.join(OUTPUT_DIR, files[0]);
  log(`Lendo: ${files[0]}`);

  // Se já existe um ENRIQUECIDO do mesmo dia, usa ele para retomar
  const date = new Date().toISOString().split('T')[0];
  const outputFile = path.join(OUTPUT_DIR, `prospects-ENRIQUECIDO-${date}.csv`);

  let sourceFile = inputFile;
  if (fs.existsSync(outputFile)) {
    log(`Arquivo ENRIQUECIDO já existe, retomando: ${path.basename(outputFile)}`);
    sourceFile = outputFile;
  }

  const content = fs.readFileSync(sourceFile, 'utf8');
  const { headers, rows } = parseCSV(content);

  if (rows.length === 0) {
    console.error('CSV vazio. Rode o scraper primeiro.');
    process.exit(1);
  }

  // Adiciona novas colunas (inclui Enriquecido como flag de processamento)
  const newHeaders = [...headers];
  for (const col of ['Email', 'Instagram', 'WhatsApp', 'Enriquecido', 'Status_Envio']) {
    if (!newHeaders.includes(col)) newHeaders.push(col);
  }

  // Filtra rows que ainda NÃO foram tentados (não têm flag Enriquecido='sim')
  const pending = rows.filter(r => r.Enriquecido !== 'sim');
  const alreadyDone = rows.length - pending.length;

  log(`${rows.length} prospects total`);
  log(`${alreadyDone} já processados (pulando)`);
  log(`${pending.length} pendentes para processar`);
  log(`Concorrência: ${CONCURRENCY} workers paralelos`);
  log(`Para mudar: CONCURRENCY=2 node enrich.js\n`);

  if (pending.length === 0) {
    log('Nada a enriquecer. Saindo.');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--lang=pt-BR',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  // Detecta desconexão do browser
  let browserClosed = false;
  browser.on('disconnected', () => {
    browserClosed = true;
    log('!!! Browser desconectado — abortando workers');
  });

  const context = await browser.newContext({
    locale: 'pt-BR',
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // Cria N páginas (uma por worker)
  const pages = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    pages.push(await context.newPage());
  }

  // Fila de trabalho compartilhada
  const queue = [...pending];
  const total = queue.length;
  let completed = 0;
  let savePending = false;

  // Debounced save
  let lastSaveTs = 0;
  async function maybeSave(force = false) {
    const now = Date.now();
    if (savePending) return;
    if (!force && now - lastSaveTs < 1500) return;
    savePending = true;
    try {
      writeCSV(outputFile, newHeaders, rows);
      lastSaveTs = Date.now();
    } catch (err) {
      log(`Erro ao salvar CSV: ${err.message}`);
    }
    savePending = false;
  }

  // Salva no Ctrl+C
  process.on('SIGINT', async () => {
    log('\n!!! Interrupção detectada — salvando CSV...');
    await maybeSave(true);
    process.exit(0);
  });

  // Worker function
  async function worker(workerId, page) {
    while (queue.length > 0) {
      if (browserClosed) {
        log(`Worker ${workerId} abortado (browser fechado)`);
        return;
      }

      const row = queue.shift();
      if (!row) break;

      completed++;
      const idx = completed;

      try {
        await enrichRow(page, row, idx, total);
      } catch (err) {
        const isBrowserError = err.message.includes('browser has been closed')
          || err.message.includes('Target closed')
          || err.message.includes('crashed');

        if (isBrowserError) {
          log(`   [${idx}] ERRO FATAL: browser morreu — abortando worker ${workerId}`);
          browserClosed = true;
          return;
        }

        log(`   [${idx}] ERRO: ${err.message.slice(0, 80)}`);
        // Marca como tentado mesmo com erro para não ficar em loop infinito
        row.Enriquecido = 'erro';
      }

      await maybeSave();
    }
    log(`Worker ${workerId} finalizado`);
  }

  // Inicia todos os workers em paralelo
  await Promise.all(pages.map((page, i) => worker(i + 1, page)));

  // Salva versão final
  await maybeSave(true);

  try { await browser.close(); } catch {}

  // Resumo
  const comEmail = rows.filter(r => r.Email).length;
  const comInsta = rows.filter(r => r.Instagram).length;
  const comWhats = rows.filter(r => r.WhatsApp).length;
  const comAlgo = rows.filter(r => r.Email || r.Instagram || r.WhatsApp).length;
  const processados = rows.filter(r => r.Enriquecido === 'sim').length;
  const erros = rows.filter(r => r.Enriquecido === 'erro').length;

  log('\n══════════════════════════════════════════');
  log('  ENRIQUECIMENTO CONCLUIDO!');
  log(`  Processados OK: ${processados}`);
  log(`  Com erro: ${erros} (vai tentar de novo se rodar outra vez)`);
  log(`  Com email: ${comEmail}`);
  log(`  Com Instagram: ${comInsta}`);
  log(`  Com WhatsApp: ${comWhats}`);
  log(`  Com algum canal: ${comAlgo}/${rows.length}`);
  log(`  Arquivo: ${outputFile}`);
  log('══════════════════════════════════════════');

  if (browserClosed) {
    log('\n!!! Browser morreu no meio. Rode de novo para retomar:');
    log('    CONCURRENCY=2 node enrich.js');
  }
}

main().catch(err => {
  console.error('\nErro fatal:', err.message);
  process.exit(1);
});
