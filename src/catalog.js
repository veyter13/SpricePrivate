'use strict';

/**
 * Каталог продуктов — ИСТОЧНИК ИСТИНЫ ПО ЦЕНАМ.
 *
 * Цены лежат на сервере намеренно: если брать стоимость из запроса клиента,
 * любой желающий отправит себе заказ за 1 ₽ через обычный POST. При создании
 * заказа сервер берёт цену ОТСЮДА, а присланные клиентом поля игнорирует.
 *
 * Названия и описания для витрины по-прежнему в public/index.html — там картинки,
 * тексты и переводы. Здесь только то, что влияет на деньги.
 */

const FUNPAY_URL = process.env.FUNPAY_URL || 'https://funpay.com/users/16370618/';

const PRODUCTS = {
  potassium: {
    id: 'potassium',
    name: 'Potassium',
    category: 'executor',
    plans: [
      { duration: { ru: '1 Месяц', en: '1 Month' }, price: 899 },
      { duration: { ru: 'Навсегда', en: 'Forever' }, price: 2199 }
    ]
  },
  vector: {
    id: 'vector',
    name: 'Vector',
    category: 'external',
    plans: [
      { duration: { ru: '7 Дней', en: '7 Days' }, price: 249 },
      { duration: { ru: '1 Месяц', en: '1 Month' }, price: 499 },
      { duration: { ru: 'Навсегда', en: 'Forever' }, price: 1099 }
    ]
  },
  matrixhub: {
    id: 'matrixhub',
    name: 'MatrixHub',
    category: 'external',
    plans: [
      { duration: { ru: '1 Месяц', en: '1 Month' }, price: 299 },
      { duration: { ru: 'Навсегда', en: 'Forever' }, price: 599 }
    ]
  },
  spicemacro: {
    id: 'spicemacro',
    name: 'SpiceMacro',
    category: 'macro',
    plans: [
      { duration: { ru: '1 Месяц', en: '1 Month' }, price: 199 },
      { duration: { ru: '90 Дней', en: '90 Days' }, price: 299 },
      { duration: { ru: 'Навсегда', en: 'Forever' }, price: 499 }
    ]
  },
  spriceoverlay: {
    id: 'spriceoverlay',
    name: 'SpriceOverlay',
    category: 'external',
    plans: [{ duration: { ru: 'Навсегда', en: 'Forever' }, price: 699 }]
  }
};

const IDS = Object.keys(PRODUCTS);

/** «2 199 ₽» — неразрывные пробелы: число не разрывается переносом строки */
function formatPrice(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + '\u00a0₽';
}

function getProduct(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, id) ? PRODUCTS[id] : null;
}

function getPlan(id, idx) {
  const p = getProduct(id);
  if (!p) return null;
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= p.plans.length) return null;
  return p.plans[i];
}

/** Минимальная цена продукта — для «от 899 ₽» на витрине */
function minPrice(id) {
  const p = getProduct(id);
  return p ? Math.min(...p.plans.map((x) => x.price)) : null;
}

/** Отдача наружу: цены числом + готовые строки, чтобы фронт не дублировал формат */
function publicCatalog(locale) {
  const loc = locale === 'en' ? 'en' : 'ru';
  return IDS.map((id) => {
    const p = PRODUCTS[id];
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      funpay: FUNPAY_URL,
      plans: p.plans.map((pl, idx) => ({
        idx,
        duration: pl.duration[loc],
        price: pl.price,
        priceText: formatPrice(pl.price)
      }))
    };
  });
}

module.exports = {
  FUNPAY_URL,
  IDS,
  PRODUCTS,
  getProduct,
  getPlan,
  minPrice,
  formatPrice,
  publicCatalog
};
