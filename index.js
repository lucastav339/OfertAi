import 'dotenv/config';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';

const {
  TELEGRAM_TOKEN,
  SEARCH_TERMS = 'smartphone,notebook',
  CRON_SCHEDULE = '*/120 * * * *',
  BROADCAST_CHAT_ID // ex.: @meucanal
} = process.env;

if (!TELEGRAM_TOKEN) {
  console.error('Faltando TELEGRAM_TOKEN no .env');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// “Banco” simples em memória (troque por Redis/Postgres depois)
const subscribers = new Set();
const sentCache = new Set(); // para evitar repetir o mesmo item seguidamente

async function fetchDealsForTerm(term) {
  // busca rápida (ajuste 'limit' e 'sort' como quiser)
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(term)}&limit=5&sort=sold_quantity_desc`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (!data?.results) return [];
  return data.results.map(item => ({
    id: item.id,
    title: item.title,
    price: item.price,
    original_price: item.original_price,
    currency: item.currency_id,
    permalink: item.permalink,
    thumbnail: item.thumbnail // pode vir com resolução baixa; dá pro gasto
  }));
}

function buildCaption(deal) {
  const price = deal.price?.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const old = deal.original_price
    ? deal.original_price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : null;
  const off = deal.original_price ? Math.round((1 - deal.price / deal.original_price) * 100) : null;

  const lines = [];
  lines.push('🔥 <b>Oferta Mercado Livre</b>');
  lines.push(`🛍️ <b>${deal.title}</b>`);
  if (old && off >= 5) lines.push(`💸 <s>${old}</s> ➜ <b>${price}</b> (${off}% OFF)`);
  else lines.push(`💸 <b>${price}</b>`);
  return lines.join('\n');
}

async function sendDeal(chatId, deal) {
  const caption = buildCaption(deal);
  const markup = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: 'Comprar agora', url: deal.permalink }]]
    }
  };

  // tenta mandar com imagem; se falhar, manda só texto
  try {
    await bot.sendPhoto(chatId, deal.thumbnail, { caption, ...markup });
  } catch {
    await bot.sendMessage(chatId, `${caption}\n\n🔗 ${deal.permalink}`, { parse_mode: 'HTML' });
  }
}

async function sendDealsToChat(chatId) {
  const terms = SEARCH_TERMS.split(',').map(t => t.trim()).filter(Boolean);
  for (const term of terms) {
    try {
      const deals = await fetchDealsForTerm(term);
      for (const d of deals) {
        // Evita spam do mesmo item em sequência
        const key = `${chatId}:${d.id}`;
        if (sentCache.has(key)) continue;
        await sendDeal(chatId, d);
        sentCache.add(key);
      }
    } catch (e) {
      console.error('Erro ao buscar/enviar ofertas:', e.message);
    }
  }
  // Limpeza simples do cache (mantém leve em execuções longas)
  if (sentCache.size > 2000) {
    for (const v of Array.from(sentCache).slice(0, 1000)) sentCache.delete(v);
  }
}

/** Comandos **/
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  subscribers.add(chatId);
  await bot.sendMessage(
    chatId,
    'Bem-vindo! ✅ Você receberá promoções automáticas do Mercado Livre (sem links de afiliado).\n\nUse /stop para parar.\nUse /ofertas para ver agora.'
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

/** Cron: envia para inscritos e, opcionalmente, num canal */
cron.schedule(CRON_SCHEDULE, async () => {
  console.log('Disparo automático:', new Date().toISOString());
  for (const chatId of subscribers) {
    await sendDealsToChat(chatId);
  }
  if (BROADCAST_CHAT_ID) {
    await sendDealsToChat(BROADCAST_CHAT_ID);
  }
});

console.log('Bot rodando. Aguardando /start…');
