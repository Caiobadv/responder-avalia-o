#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ╔══════════════════════════════════════════════════════════════╗
// ║              CONFIGURAÇÃO - EDITE AQUI                      ║
// ║  Adicione/remova cidades e categorias como quiser           ║
// ╚══════════════════════════════════════════════════════════════╝

const CIDADES = [
  'Recife, PE',
  'Olinda, PE',
  'Jaboatão dos Guararapes, PE',
  // 'Caruaru, PE',
  // 'Petrolina, PE',
  // 'Campina Grande, PB',
  // 'João Pessoa, PB',
  // 'Maceió, AL',
];

const CATEGORIAS = [
  'hotel',
  'pousada',
  'restaurante',
  'agência de turismo',
  'passeio turístico',
  // 'bar',
  // 'clínica',
  // 'salão de beleza',
  // 'barbearia',
];

const MIN_REVIEWS = 10;        // Ignora negócios com menos reviews
const MAX_POR_BUSCA = 40;      // Máximo de negócios processados por busca
const MAX_TAXA_RESPOSTA = 0.3; // 30% — abaixo disso é prospect

// ══════════════════════════════════════════════════════════════
//                    NÃO EDITE ABAIXO
// ══════════════════════════════════════════════════════════════

const OUTPUT_DIR = path.join(__dirname, 'output');
const PROGRESS_FILE = path.join(OUTPUT_DIR, '.progress.json');

function sleep(min = 2000, max = 4000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function log(msg) {
  const time = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${time}] ${msg}`);
}

function escapeCSV(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes(';')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function appendCSV(file, row) {
  const line = Object.values(row).map(escapeCSV).join(',') + '\n';
  fs.appendFileSync(file, line, 'utf8');
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch {}
  return { processedUrls: [] };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress), 'utf8');
}

// Aceita cookies do Google na primeira visita
async function handleConsent(page) {
  try {
    const patterns = [
      'Aceitar tudo',
      'Accept all',
      'Rejeitar tudo',
      'Reject all',
    ];
    for (const text of patterns) {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await sleep(1500, 2500);
        return;
      }
    }
  } catch {}
}

// Scroll no painel de resultados para carregar mais negócios
async function scrollResultsFeed(page) {
  const feed = page.locator('div[role="feed"]');
  const isVisible = await feed.isVisible({ timeout: 5000 }).catch(() => false);
  if (!isVisible) return;

  let prevHeight = 0;
  for (let i = 0; i < 10; i++) {
    const height = await feed.evaluate(el => {
      el.scrollBy(0, 2000);
      return el.scrollHeight;
    });

    await sleep(1500, 2500);

    // Verifica se chegou ao fim (texto "Você chegou ao fim da lista")
    const endOfList = await page.locator('text=/chegou ao fim|end of list/i')
      .isVisible({ timeout: 500 }).catch(() => false);
    if (endOfList) break;

    // Sem mais conteúdo novo
    if (height === prevHeight && i > 2) break;
    prevHeight = height;
  }
}

// Coleta todos os links de negócios dos resultados da busca
// Extrai dados direto dos elementos DOM (não depende do formato do aria-label)
async function collectBusinessLinks(page) {
  await sleep(1000, 2000);

  const links = await page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return [];

    const results = [];
    const seen = new Set();

    // Cada resultado é um div filho do feed que contém um link /maps/place/
    const items = feed.querySelectorAll(':scope > div');

    for (const item of items) {
      const anchor = item.querySelector('a[href*="/maps/place/"]');
      if (!anchor) continue;

      const url = anchor.href;
      if (seen.has(url)) continue;
      seen.add(url);

      // Nome: aria-label do link principal, ou texto do primeiro heading
      const name = anchor.getAttribute('aria-label') || '';

      // Nota e reviews: busca no texto do card inteiro
      const cardText = item.innerText || '';

      // Nota: formato "4,2" ou "4.2" geralmente perto de estrelas
      let rating = 0;
      const ratingMatch = cardText.match(/(\d[,.]\d)\s/);
      if (ratingMatch) {
        rating = parseFloat(ratingMatch[1].replace(',', '.'));
      }

      // Reviews: formato "(890)" ou "(1.234)" ou "890 avaliações" ou "890 reviews"
      let reviewCount = 0;
      // Tenta formato com parênteses: (890) ou (1.234)
      const countMatch = cardText.match(/\(([\d.]+)\)/);
      if (countMatch) {
        reviewCount = parseInt(countMatch[1].replace(/\./g, ''), 10);
      }
      // Fallback: "890 avaliações" ou "890 reviews"
      if (reviewCount === 0) {
        const altMatch = cardText.match(/([\d.]+)\s*(?:avaliações|avaliacao|reviews|review)/i);
        if (altMatch) {
          reviewCount = parseInt(altMatch[1].replace(/\./g, ''), 10);
        }
      }

      // Endereço: geralmente uma das últimas linhas do card
      let address = '';
      const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
      // Endereço costuma ser uma linha longa com rua/bairro
      for (const line of lines.slice(2)) {
        if (line.match(/^(R\.|Rua|Av\.|Avenida|Estr\.|Rod\.|Al\.|Alameda|Pça|Praça|Trav)/i) ||
            line.match(/\d{5}/) || // CEP
            line.match(/, \d+/) // número
        ) {
          address = line;
          break;
        }
      }

      if (name) {
        results.push({ url, name, rating, reviewCount, address });
      }
    }

    return results;
  });

  return links;
}

// Extrai telefone e website da página de detalhes do negócio
async function extractContactInfo(page) {
  return await page.evaluate(() => {
    let phone = '';
    let website = '';

    // Telefone — botões com aria-label contendo "telefone" ou "phone"
    const allButtons = document.querySelectorAll('button[aria-label], a[aria-label]');
    for (const el of allButtons) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();

      if (!phone && (label.includes('telefone') || label.includes('phone'))) {
        // Extrai números do label
        const match = (el.getAttribute('aria-label') || '').match(/[\d\s\(\)\-\+]{8,}/);
        if (match) phone = match[0].trim();
      }

      if (!website && (label.includes('site') || label.includes('website'))) {
        // O aria-label geralmente tem o domínio
        const href = el.href || el.getAttribute('data-href') || '';
        if (href && !href.includes('google.com') && !href.includes('maps')) {
          website = href;
        } else {
          // Tenta extrair do texto do label
          const urlMatch = (el.getAttribute('aria-label') || '').match(/https?:\/\/\S+|www\.\S+|\S+\.\w{2,}/);
          if (urlMatch) website = urlMatch[0];
        }
      }
    }

    // Fallback: busca links tel: na página
    if (!phone) {
      const telLinks = document.querySelectorAll('a[href^="tel:"]');
      for (const tel of telLinks) {
        const num = tel.href.replace('tel:', '').trim();
        if (num.length >= 8) { phone = num; break; }
      }
    }

    return { phone, website };
  });
}

// Verifica a taxa de resposta do proprietário nas avaliações
async function checkReviewResponses(page) {
  try {
    // Tenta clicar na aba de Avaliações
    const tabTexts = ['Avaliações', 'Reviews', 'avaliações'];
    let tabClicked = false;

    for (const text of tabTexts) {
      try {
        const tab = page.locator(`button[role="tab"]:has-text("${text}")`).first();
        if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
          await tab.click();
          tabClicked = true;
          break;
        }
      } catch {}
    }

    if (!tabClicked) {
      // Fallback: tenta clicar em qualquer elemento com texto "avaliações"
      try {
        const fallback = page.locator('button:has-text("avaliações"), button:has-text("reviews")').first();
        if (await fallback.isVisible({ timeout: 2000 }).catch(() => false)) {
          await fallback.click();
          tabClicked = true;
        }
      } catch {}
    }

    if (!tabClicked) return { total: 0, withResponse: 0 };

    await sleep(2500, 3500);

    // Scroll mais agressivo para carregar pelo menos 20-30 reviews
    const scrollSelectors = [
      'div.m6QErb.DxyBCb.kA9KIf.dS8AEf',
      'div[role="main"] div.m6QErb',
      'div.m6QErb[tabindex="-1"]',
    ];

    let scrollable = null;
    for (const sel of scrollSelectors) {
      const candidate = page.locator(sel).first();
      if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
        scrollable = candidate;
        break;
      }
    }

    if (scrollable) {
      let prevCount = 0;
      for (let i = 0; i < 6; i++) {
        await scrollable.evaluate(el => el.scrollBy(0, 2000));
        await sleep(700, 1100);

        // Verifica se já carregou reviews suficientes ou se parou de carregar
        const currentCount = await page.evaluate(() =>
          document.querySelectorAll('[data-review-id]').length
        );
        if (currentCount >= 30) break;
        if (currentCount === prevCount && i > 1) break;
        prevCount = currentCount;
      }
    }

    // Conta reviews e respostas baseado em elementos DOM (não regex de texto)
    const counts = await page.evaluate(() => {
      // Reviews têm atributo data-review-id
      const reviewEls = document.querySelectorAll('[data-review-id]');
      const total = reviewEls.length;

      if (total === 0) return { total: 0, responses: 0 };

      // Para cada review, verifica se tem resposta do proprietário dentro do container
      let responses = 0;
      const responseRegex = /Resposta d[oae] (proprietári[oa]|empresa)|Response from (the )?owner/i;

      for (const el of reviewEls) {
        const text = el.innerText || '';
        if (responseRegex.test(text)) {
          responses++;
        }
      }

      return { total, responses };
    });

    return { total: counts.total, withResponse: counts.responses };

  } catch (err) {
    log(`      Erro ao verificar reviews: ${err.message}`);
    return { total: 0, withResponse: 0 };
  }
}

// ══════════════════════════════════════════════════════════════
//                        MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const outputFile = path.join(OUTPUT_DIR, `prospects-${date}.csv`);

  // Carrega progresso anterior (para retomar se parou no meio)
  const progress = loadProgress();
  const isResume = progress.processedUrls.length > 0;

  if (isResume) {
    log(`Retomando execução anterior (${progress.processedUrls.length} já processados)`);
  }

  // Cria CSV com header se é uma nova execução
  if (!isResume || !fs.existsSync(outputFile)) {
    fs.writeFileSync(outputFile, [
      'Nome',
      'Categoria',
      'Cidade',
      'Nota',
      'Total Reviews',
      'Reviews Verificadas',
      'Com Resposta',
      'Sem Resposta',
      'Taxa Resposta (%)',
      'Telefone',
      'Endereco',
      'Website',
      'Google Maps',
    ].join(',') + '\n', 'utf8');
  }

  log('Iniciando scraper RespondeAI...');
  log(`Cidades: ${CIDADES.join(', ')}`);
  log(`Categorias: ${CATEGORIAS.join(', ')}`);
  log(`Min reviews: ${MIN_REVIEWS} | Max por busca: ${MAX_POR_BUSCA}`);
  log('');

  const browser = await chromium.launch({
    headless: false,
    args: ['--lang=pt-BR', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    locale: 'pt-BR',
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  let firstVisit = true;
  let totalProspects = 0;
  let totalProcessed = 0;

  const totalBuscas = CIDADES.length * CATEGORIAS.length;
  let buscaAtual = 0;

  for (const cidade of CIDADES) {
    for (const categoria of CATEGORIAS) {
      buscaAtual++;
      const query = `${categoria} em ${cidade}`;
      log(`\n[${ buscaAtual}/${totalBuscas}] Buscando: ${query}`);

      try {
        // Navega para a busca
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Aceita cookies na primeira visita
        if (firstVisit) {
          await handleConsent(page);
          firstVisit = false;
        }

        await sleep(3000, 5000);

        // Scroll para carregar mais resultados
        await scrollResultsFeed(page);

        // Coleta links dos negócios
        const links = await collectBusinessLinks(page);
        log(`   ${links.length} negocios encontrados`);

        let processedThisSearch = 0;

        for (const biz of links) {
          if (processedThisSearch >= MAX_POR_BUSCA) break;

          // Pula se já foi processado (retomada)
          if (progress.processedUrls.includes(biz.url)) {
            continue;
          }

          if (!biz.name) continue;

          // Filtra por mínimo de reviews (se conseguiu extrair o count)
          if (biz.reviewCount > 0 && biz.reviewCount < MIN_REVIEWS) {
            continue;
          }

          log(`   Processando: ${biz.name} (${biz.reviewCount || '?'} reviews)...`);

          try {
            // Navega para a página do negócio
            await page.goto(biz.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await sleep(2000, 3500);

            // Se não conseguiu pegar reviewCount da listagem, tenta da página de detalhes
            let totalReviews = biz.reviewCount;
            let rating = biz.rating;
            if (totalReviews === 0 || rating === 0) {
              const detailInfo = await page.evaluate(() => {
                const text = document.body.innerText || '';
                let rc = 0;
                let rt = 0;

                // Tenta "X avaliações" ou "X reviews"
                const rcMatch = text.match(/([\d.]+)\s*(?:avaliações|avaliacao|reviews)/i);
                if (rcMatch) rc = parseInt(rcMatch[1].replace(/\./g, ''), 10);

                // Tenta "(X)" perto de estrelas
                if (rc === 0) {
                  const altMatch = text.match(/\(([\d.]+)\)/);
                  if (altMatch) rc = parseInt(altMatch[1].replace(/\./g, ''), 10);
                }

                // Nota
                const rtMatch = text.match(/(\d[,.]\d)\s/);
                if (rtMatch) rt = parseFloat(rtMatch[1].replace(',', '.'));

                return { reviewCount: rc, rating: rt };
              });

              if (totalReviews === 0) totalReviews = detailInfo.reviewCount;
              if (rating === 0) rating = detailInfo.rating;
            }

            // Filtra por mínimo de reviews (agora com dados da página)
            if (totalReviews > 0 && totalReviews < MIN_REVIEWS) {
              log(`   -> Apenas ${totalReviews} reviews, pulando`);
              progress.processedUrls.push(biz.url);
              saveProgress(progress);
              continue;
            }

            // Extrai telefone e website
            const contact = await extractContactInfo(page);

            // Verifica respostas nas avaliações
            const reviewCheck = await checkReviewResponses(page);

            const responseRate = reviewCheck.total > 0
              ? reviewCheck.withResponse / reviewCheck.total
              : 0;

            const semResposta = reviewCheck.total - reviewCheck.withResponse;

            if (responseRate <= MAX_TAXA_RESPOSTA) {
              // PROSPECT ENCONTRADO
              appendCSV(outputFile, {
                nome: biz.name,
                categoria,
                cidade,
                nota: rating,
                totalReviews: totalReviews,
                reviewsVerificadas: reviewCheck.total,
                comResposta: reviewCheck.withResponse,
                semResposta,
                taxaResposta: Math.round(responseRate * 100),
                telefone: contact.phone,
                endereco: biz.address,
                website: contact.website,
                googleMaps: biz.url,
              });

              totalProspects++;
              log(`   -> PROSPECT! ${Math.round(responseRate * 100)}% respostas (${reviewCheck.withResponse}/${reviewCheck.total})`);
            } else {
              log(`   -> Responde ${Math.round(responseRate * 100)}% — nao e prospect`);
            }

            processedThisSearch++;
            totalProcessed++;

            // Salva progresso
            progress.processedUrls.push(biz.url);
            saveProgress(progress);

          } catch (err) {
            log(`   ERRO ao processar ${biz.name}: ${err.message}`);
          }

          // Delay entre negócios (evita detecção)
          await sleep(2500, 4500);
        }

        log(`   Processados: ${processedThisSearch} negocios nesta busca`);

      } catch (err) {
        log(`   ERRO na busca "${query}": ${err.message}`);
      }

      // Delay entre buscas
      await sleep(3000, 5000);
    }
  }

  // Limpa arquivo de progresso
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}

  await browser.close();

  log('\n══════════════════════════════════════════');
  log(`  CONCLUIDO!`);
  log(`  Total processados: ${totalProcessed}`);
  log(`  Prospects encontrados: ${totalProspects}`);
  log(`  Arquivo: ${outputFile}`);
  log('══════════════════════════════════════════');
}

main().catch(err => {
  console.error('\nErro fatal:', err.message);
  console.error('O progresso foi salvo. Execute novamente para retomar.');
  process.exit(1);
});
