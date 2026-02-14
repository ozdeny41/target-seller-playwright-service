/**
 * sellerDbService.js (TARGET SELLER)
 * Target-Seller-Postgresql'e dogrudan kayit — target seller servisi veri cektigi anda DB'ye yazar.
 * Backend'e bagimli degil, HTTP timeout sorunlarindan etkilenmez.
 * 
 * FARK: "Seller" tablosu yerine "TargetSeller" tablosu kullanilir.
 * FARK: sourceMarketplace yerine targetMarketplace alani kullanilir.
 */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  const dbUrl = process.env.SELLER_DATABASE_URL;
  if (!dbUrl) {
    console.warn('⚠️ [TargetSellerDB] SELLER_DATABASE_URL tanimli degil — DB kayit devre disi');
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
      pool = null;
    });

    console.log(`✅ [TargetSellerDB] PostgreSQL pool olusturuldu (${isInternal ? 'internal' : 'public'})`);
    return pool;
  } catch (e) {
    console.error('❌ [TargetSellerDB] Pool olusturma hatasi:', e.message);
    return null;
  }
}

/**
 * Target Seller verilerini Target-Seller-Postgresql'e kaydet.
 * Once ASIN+targetMarketplace icin eski kayitlari sil, sonra yenilerini ekle.
 *
 * @param {string} asin
 * @param {string} targetMarketplace - Hedef pazar (navbar secili ulke: amazon.co.uk, amazon.de, vb.)
 * @param {string|null} targetCountry
 * @param {Array} sellers - Playwright'tan gelen seller listesi
 */
async function saveSellers(asin, targetMarketplace, targetCountry, sellers) {
  const db = getPool();
  if (!db) return;
  if (!sellers || sellers.length === 0) {
    console.log(`⚠️ [TargetSellerDB] ${asin} icin seller yok, kayit atlandi`);
    return;
  }

  const client = await db.connect().catch(e => {
    console.error(`❌ [TargetSellerDB] ${asin} baglanti hatasi:`, e.message);
    return null;
  });
  if (!client) return;

  try {
    // Eski kayitlari sil
    await client.query(
      `DELETE FROM "TargetSeller" WHERE asin = $1 AND "targetMarketplace" = $2`,
      [asin, targetMarketplace || 'amazon.com']
    );

    // Yeni kayitlari ekle
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
      const id = `tsel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${i}`;

      const values = [
        id,                                                      // id
        'auto',                                                  // inventoryItemId
        asin,                                                    // asin
        'system',                                                // userId
        targetMarketplace || 'amazon.com',                       // targetMarketplace
        targetCountry || null,                                   // targetMarket
        s.sellerName || s.soldBy || null,                        // sellerName
        s.soldBy || s.sellerName || null,                        // soldBy
        s.sellerId || null,                                      // sellerId
        s.sellerRating != null ? parseFloat(s.sellerRating) || null : null,
        s.sellerRatingCount != null ? parseInt(s.sellerRatingCount) || null : null,
        s.positivePercentage != null ? parseFloat(s.positivePercentage) || null : null,
        s.condition || null,                                     // condition
        !!s.isNew,                                               // isNew
        !!s.isUsed,                                              // isUsed
        s.price != null ? parseFloat(s.price) || null : null,
        s.priceText || null,
        s.primePrice != null ? parseFloat(s.primePrice) || null : null,
        s.primePriceText || null,
        s.shipsFrom || null,
        s.shippingPrice != null ? parseFloat(s.shippingPrice) || null : null,
        s.standardShippingPrice != null ? parseFloat(s.standardShippingPrice) || null : null,
        s.expressShippingPrice != null ? parseFloat(s.expressShippingPrice) || null : null,
        s.deliveryDate || s.standardDeliveryDate || null,
        s.standardDeliveryDate || null,
        s.expressDeliveryDate || null,
        s.marketplace || 'target',                               // marketplace = 'target'
        i,                                                       // offerIndex
        now,                                                     // fetchedAt
        now,                                                     // createdAt
        now                                                      // updatedAt
      ];

      try {
        await client.query(insertQuery, values);
        saved++;
      } catch (insertErr) {
        console.error(`❌ [TargetSellerDB] ${asin} seller #${i} insert hatasi:`, insertErr.message);
      }
    }

    console.log(`✅ [TargetSellerDB] ${asin} → ${saved}/${sellers.length} seller Target-Seller-Postgresql'e kaydedildi`);
  } catch (e) {
    console.error(`❌ [TargetSellerDB] ${asin} kayit hatasi:`, e.message);
  } finally {
    client.release();
  }
}

/**
 * DB baglanti testi
 */
async function testConnection() {
  const db = getPool();
  if (!db) return false;
  try {
    const result = await db.query('SELECT 1 as ok');
    console.log('✅ [TargetSellerDB] Baglanti testi basarili');
    return true;
  } catch (e) {
    console.error('❌ [TargetSellerDB] Baglanti testi basarisiz:', e.message);
    return false;
  }
}

module.exports = { saveSellers, testConnection };
