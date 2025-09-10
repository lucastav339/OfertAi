import 'dotenv/config';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';

/**
 * Config
 */
const {
  TELEGRAM_TOKEN,
  SEARCH_TERMS = 'smartphone,notebook',
  CRON_SCHEDULE = '*/120 * * * *',
  BROADCAST_CHAT_ID,                 // ex.: @meu_canal_publico
  USE_HEALTH_SERVER                  // se TRUE, assegure que chamou server.js no start
} = process.env;

if (!TELEGRAM_TOKEN) {
  console.error('Faltando TELEGRAM_TOKEN no .env');
  process.exit(1);
}

// Se quiser forçar o “health server” no mesmo processo (não é necessário para Background Worker)
// Dica: prefira rodar "node server.js && node index.js" no script start:web do package.json
if (USE_HEALTH_SERVER) {
  try {
    await import('./server.js');
  } catch (e) {
    console.warn('Falha ao iniciar health server (server.js):', e.message);
  }
}

// Inicializa bot (long polling)
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// “Banco” simples em memória (troque por Redis/Postgres em produção)
const subscribers = new Set();
// Evita repetir o mesmo item frequentemente por chat
const sentCache = new Set(); // chave: `${chatId}:${itemId}`

/**
 * Busca ofertas no Mercado Livre por termo
 * Docs públicas: GET https://api.mercadolibre.com/sites/MLB/search?q=...
 */
async function fetchDealsForTerm(term) {
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(term)}&limit=5&sort=sold_quantity_desc`;
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'OfertAiBot/1.0 (+https://t.me/OfertAiBot)',
        'Accept': 'application/json'
      }
    });
    if (!data?.results) return [];
    return data.results.map(item => ({
      id: item.id,
      title: item.title,
      price: item.price,
      original_price: item.original_price,
      currency: item.currency_id,
      permalink: item.permalink,
      // Algumas thumbnails vêm com resolução baixa, mas funcionam no Telegram
      thumbnail: item.thumbnail || item.thumbnail_id || null
    }));
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    console.error('ML request error:', status, body || err.message);
    throw err;
  }
}

/**
 * Formata o texto (caption) da oferta
 */
function formatCaption(deal) {
  const price = deal.price != null
    ? deal.price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '—';

  const old = deal.original_price != null
    ? deal.original_price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : null;

  const off = (deal.original_price && deal.price)
    ? Math.round((1 - deal.price / deal.original_price) * 100)
    : null;

  const lines = [];
  lines.push('🔥 <b>Oferta Mercado Livre</b>');
  lines.push(`🛍️ <b>${deal.title}</b>`);
  if (old && off >= 5) lines.push(`💸 <s>${old}</s> ➜ <b>${price}</b> (${off}% OFF)`);
  else lines.push(`💸 <b>${price}</b>`);
  return lines.join('\n');
}

/**
 * Envia uma oferta para um chat
 */
async function sendDeal(chatId, deal) {
  const caption = formatCaption(deal);
  const markup = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: 'Comprar agora', url: deal.permalink }]]
    }
  };

  // Tenta enviar com imagem; se falhar, envia apenas texto
  try {
    if (deal.thumbnail) {
      await bot.sendPhoto(chatId, deal.thumbnail, { caption, ...markup });
    } else {
      throw new Error('Sem thumbnail');
    }
  } catch {
    await bot.sendMessage(chatId, `${caption}\n\n🔗 ${deal.permalink}`, { parse_mode: 'HTML' });
  }
}

/**
 * Envia um lote de ofertas para um chat
 */
async function sendDealsToChat(chatId) {
  const terms = SEARCH_TERMS.split(',').map(t => t.trim()).filter(Boolean);

  for (const term of terms) {
    try {
      const deals = await fetchDealsForTerm(term);

      for (const d of deals) {
        const key = `${chatId}:${d.id}`;
        if (sentCache.has(key)) continue; // evita spam do mesmo item
        await sendDeal(chatId, d);
        sentCache.add(key);
      }
    } catch (e) {
      console.error('Erro ao buscar/enviar ofertas:', e.message);
    }
  }

  // Limpeza simples do cache para não crescer sem limites
  if (sentCache.size > 5000) {
    for (const v of Array.from(sentCache).slice(0, 2500)) sentCache.delete(v);
  }
}

/**
 * Comandos do bot
 */
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  subscribers.add(chatId);
  await bot.sendMessage(
    chatId,
    'Bem-vindo! ✅ Você receberá promoções automáticas do Mercado Livre.\n\nComandos:\n/stop – parar de receber\n/ofertas – ver ofertas agora'
  );
  await sendDealsToChat(chatId);
});

bot.onText(/^\/stop$/, async (msg) => {
  const chatId = msg.chat.id;
  subscribers.delete(chatId);
  await bot.sendMessage(chatId, 'Você foi descadastrado. ❌ Não enviarei mais ofertas automáticas.');
});

bot.onText(/^\/ofertas?$/i, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, 'Buscando ofertas… 🔎');
  await sendDealsToChat(chatId);
});

/**
 * Cron: envio automático para inscritos e, opcionalmente, para um canal
 */
if (CRON_SCHEDULE) {
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log('Disparo automático:', new Date().toISOString());
    for (const chatId of subscribers) {
      await sendDealsToChat(chatId);
    }
    if (BROADCAST_CHAT_ID) {
      await sendDealsToChat(BROADCAST_CHAT_ID);
    }
  });
}

console.log('Bot rodando. Aguardando /start…');
