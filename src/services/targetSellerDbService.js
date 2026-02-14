/**
 * targetSellerDbService.js
 * Target-Seller-Postgresql'e doğrudan kayıt — target seller servisi veri çektiği anda DB'ye yazar.
 * Backend'e bağımlı değil, HTTP timeout sorunlarından etkilenmez.
 * 
 * FARK: Mevcut sellerDbService.js'den farkı:
 * - Tablo adı: "TargetSeller" (mevcut: "Seller")
 * - Alan adı: "targetMarketplace" (mevcut: "sourceMarketplace")
 * - marketplace varsayılan: 'target' (mevcut: 'source')
 */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  const dbUrl = process.env.SELLER_DATABASE_URL;
  if (!dbUrl) {
    console.warn('⚠️ [TargetSellerDB] SELLER_DATABASE_URL tanımlı değil — DB kayıt devre dışı');
    return null;
  }

  try {
    const isInternal = dbUrl.includes('.railway.internal');
    pool = new Pool({
      connectionString: dbUrl,
      ssl: isInternal ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('❌ [TargetSellerDB] Pool error:', err.message);
      pool = null; // Reconnect on next call
    });

    console.log(`✅ [TargetSellerDB] PostgreSQL pool oluşturuldu (${isInternal ? 'internal' : 'public'})`);
    return pool;
  } catch (e) {
    console.error('❌ [TargetSellerDB] Pool oluşturma hatası:', e.message);
    return null;
  }
}

/**
 * Target seller verilerini Target-Seller-Postgresql'e kaydet.
 * Önce ASIN+targetMarketplace için eski kayıtları sil, sonra yenilerini ekle.
 *
 * @param {string} asin
 * @param {string} targetMarketplace - Hedef pazar (amazon.co.uk, amazon.de, vb.)
 * @param {string|null} targetCountry
 * @param {Array} sellers - Playwright'tan gelen seller listesi
 */
async function saveSellers(asin, targetMarketplace, targetCountry, sellers) {
  const db = getPool();
  if (!db) return;
  if (!sellers || sellers.length === 0) {
    console.log(`⚠️ [TargetSellerDB] ${asin} için seller yok, kayıt atlandı`);
    return;
  }

  const client = await db.connect().catch(e => {
    console.error(`❌ [TargetSellerDB] ${asin} bağlantı hatası:`, e.message);
    return null;
  });
  if (!client) return;

  try {
    // Eski kayıtları sil (FARK: "TargetSeller" tablosu, "targetMarketplace" alanı)
    await client.query(
      `DELETE FROM "TargetSeller" WHERE asin = $1 AND "targetMarketplace" = $2`,
      [asin, targetMarketplace || 'amazon.com']
    );

    // Yeni kayıtları ekle
    const insertQuery = `
      INSERT INTO "TargetSeller" (
        id, "inventoryItemId", asin, "userId", "targetMarketplace", "targetMarket",
        "sellerName", "soldBy", "sellerId", "sellerRating", "sellerRatingCount", "positivePercentage",
        condition, "isNew", "isUsed", price, "priceText", "primePrice", "primePriceText",
        "shipsFrom", "shippingPrice", "standardShippingPrice", "expressShippingPrice",
        "deliveryDate", "standardDeliveryDate", "expressDeliveryDate",
        marketplace, "offerIndex", "fetchedAt", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26,
        $27, $28, $29, $30, $31
      )`;

    const now = new Date();
    let saved = 0;

    for (let i = 0; i < sellers.length; i++) {
      const s = sellers[i];
      // cuid benzeri unique ID oluştur
      const id = `tsel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${i}`;

      const values = [
        id,                                                      // id
        'auto',                                                  // inventoryItemId (backend dolduracak)
        asin,                                                    // asin
        'system',                                                // userId (backend dolduracak)
        targetMarketplace || 'amazon.com',                       // targetMarketplace (FARK: sourceMarketplace değil)
        targetCountry || null,                                   // targetMarket
        s.sellerName || s.soldBy || null,                        // sellerName
        s.soldBy || s.sellerName || null,                        // soldBy
        s.sellerId || null,                                      // sellerId
        s.sellerRating != null ? parseFloat(s.sellerRating) || null : null,    // sellerRating
        s.sellerRatingCount != null ? parseInt(s.sellerRatingCount) || null : null, // sellerRatingCount
        s.positivePercentage != null ? parseFloat(s.positivePercentage) || null : null, // positivePercentage
        s.condition || null,                                     // condition
        !!s.isNew,                                               // isNew
        !!s.isUsed,                                              // isUsed
        s.price != null ? parseFloat(s.price) || null : null,   // price
        s.priceText || null,                                     // priceText
        s.primePrice != null ? parseFloat(s.primePrice) || null : null,   // primePrice
        s.primePriceText || null,                                // primePriceText
        s.shipsFrom || null,                                     // shipsFrom
        s.shippingPrice != null ? parseFloat(s.shippingPrice) || null : null, // shippingPrice
        s.standardShippingPrice != null ? parseFloat(s.standardShippingPrice) || null : null, // standardShippingPrice
        s.expressShippingPrice != null ? parseFloat(s.expressShippingPrice) || null : null,   // expressShippingPrice
        s.deliveryDate || s.standardDeliveryDate || null,        // deliveryDate
        s.standardDeliveryDate || null,                          // standardDeliveryDate
        s.expressDeliveryDate || null,                           // expressDeliveryDate
        s.marketplace || 'target',                               // marketplace (FARK: varsayılan 'target')
        i,                                                       // offerIndex
        now,                                                     // fetchedAt
        now,                                                     // createdAt
        now                                                      // updatedAt
      ];

      try {
        await client.query(insertQuery, values);
        saved++;
      } catch (insertErr) {
        console.error(`❌ [TargetSellerDB] ${asin} seller #${i} insert hatası:`, insertErr.message);
      }
    }

    console.log(`✅ [TargetSellerDB] ${asin} → ${saved}/${sellers.length} seller Target-Seller-Postgresql'e kaydedildi`);
  } catch (e) {
    console.error(`❌ [TargetSellerDB] ${asin} kayıt hatası:`, e.message);
  } finally {
    client.release();
  }
}

/**
 * Belirli bir ASIN + targetMarketplace için tüm TargetSeller kayıtlarını sil.
 * "Currently unavailable" ürünler için çağrılır — DB'de sahte/eski kayıt kalmasın.
 *
 * @param {string} asin
 * @param {string} targetMarketplace
 */
async function deleteSellersForAsin(asin, targetMarketplace) {
  const db = getPool();
  if (!db) return;

  try {
    const result = await db.query(
      `DELETE FROM "TargetSeller" WHERE asin = $1 AND "targetMarketplace" = $2`,
      [asin, targetMarketplace || 'amazon.com']
    );
    const deleted = result.rowCount || 0;
    if (deleted > 0) {
      console.log(`🗑️ [TargetSellerDB] ${asin} (${targetMarketplace}) → ${deleted} eski kayıt silindi (ürün unavailable)`);
    } else {
      console.log(`ℹ️ [TargetSellerDB] ${asin} (${targetMarketplace}) → silinecek kayıt yok`);
    }
  } catch (e) {
    console.error(`❌ [TargetSellerDB] ${asin} silme hatası:`, e.message);
  }
}

/**
 * DB bağlantı testi
 */
async function testConnection() {
  const db = getPool();
  if (!db) return false;
  try {
    const result = await db.query('SELECT 1 as ok');
    console.log('✅ [TargetSellerDB] Bağlantı testi başarılı');
    return true;
  } catch (e) {
    console.error('❌ [TargetSellerDB] Bağlantı testi başarısız:', e.message);
    return false;
  }
}

/**
 * ASIN + targetMarketplace için DB'deki satıcıları oku.
 * Backend'in target-sellers/:asin endpoint'inin alternatifi.
 *
 * @param {string} asin
 * @param {string} targetMarketplace
 * @returns {Promise<Array>}
 */
async function getSellersForAsin(asin, targetMarketplace) {
  const db = getPool();
  if (!db) return [];
  try {
    let query, params;
    if (targetMarketplace) {
      query = 'SELECT * FROM "TargetSeller" WHERE asin = $1 AND "targetMarketplace" = $2 ORDER BY "fetchedAt" DESC';
      params = [asin, targetMarketplace];
    } else {
      query = 'SELECT * FROM "TargetSeller" WHERE asin = $1 ORDER BY "fetchedAt" DESC';
      params = [asin];
    }
    const result = await db.query(query, params);
    return result.rows || [];
  } catch (e) {
    console.error(`❌ [TargetSellerDB] ${asin} okuma hatası:`, e.message);
    return [];
  }
}

module.exports = { saveSellers, deleteSellersForAsin, testConnection, getSellersForAsin };
