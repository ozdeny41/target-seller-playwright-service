const express = require('express');
const router = express.Router();
const playwrightService = require('../services/playwrightService');
const targetSellerDbService = require('../services/targetSellerDbService');

// KRİTİK: Queue mekanizması - EAGAIN hatalarını önlemek için
class RequestQueue {
  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
    this.processing = false;
    this.lastEAGAINTime = 0;
    this.eagainCount = 0;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const timeSinceLastEAGAIN = Date.now() - this.lastEAGAINTime;
    const eagainCooldownMs = 35000;
    if (this.lastEAGAINTime > 0 && timeSinceLastEAGAIN < eagainCooldownMs) {
      const waitTime = eagainCooldownMs - timeSinceLastEAGAIN;
      console.log(`⏳ [Target Queue] Son EAGAIN hatasından ${Math.round(timeSinceLastEAGAIN/1000)}s geçti, ${Math.round(waitTime/1000)}s daha bekleniyor...`);
      setTimeout(() => this.process(), waitTime);
      return;
    }

    this.processing = true;
    this.running++;
    const { fn, resolve, reject } = this.queue.shift();
    let isEAGAINError = false;
    let exponentialDelay = 0;

    try {
      const result = await fn();
      if (this.eagainCount > 0) {
        console.log(`✅ [Target Queue] Başarılı işlem, EAGAIN sayacı sıfırlanıyor`);
        this.eagainCount = 0;
      }
      resolve(result);
    } catch (error) {
      const errorString = error.message || error.toString() || '';
      const isEAGAIN = error.isEAGAIN || 
                      errorString.includes('EAGAIN') || 
                      errorString.includes('Resource temporarily unavailable') ||
                      errorString.includes('spawn') ||
                      errorString.includes('Failed to launch');
      
      if (isEAGAIN) {
        isEAGAINError = true;
        this.lastEAGAINTime = Date.now();
        this.eagainCount++;
        console.error(`🚫 [Target Queue] EAGAIN hatası (${this.eagainCount}. kez) - Railway kaynak limiti aşıldı.`);
        
        const baseDelay = 35000;
        exponentialDelay = Math.min(baseDelay * Math.pow(2, this.eagainCount - 1), 120000);
        
        console.error(`🚫 [Target Queue] ${Math.round(exponentialDelay/1000)} saniye bekleniyor (EAGAIN count: ${this.eagainCount})...`);
        reject(error);
      } else {
        reject(error);
      }
    } finally {
      this.running--;
      this.processing = false;

      if (isEAGAINError) {
        setTimeout(() => this.process(), exponentialDelay || 35000);
      } else {
        const delay = this.eagainCount > 0 ? 35000 : 8000;
        setTimeout(() => this.process(), delay);
      }
    }
  }
}

// Global queue instance
const requestQueue = new RequestQueue(1);

/**
 * POST /api/sellers
 * Get TARGET marketplace seller information for a product using Playwright
 * 
 * FARK: Bu servis targetMarketplace parametresini alır (navbar'da seçili ülke).
 * Mevcut seller-playwright-service ise sourceMarketplace kullanır.
 */
router.post('/', async (req, res, next) => {
  try {
    // KRİTİK FARK: targetMarketplace parametresi kullanılıyor (sourceMarketplace DEĞİL)
    const { asin, asins, targetMarketplace = 'amazon.com', targetCountry } = req.body;
    
    // Scraping için kullanılacak marketplace = targetMarketplace (navbar seçili ülke)
    const scrapingMarketplace = targetMarketplace;
    
    const asinList = Array.isArray(asins)
      ? asins.map(a => String(a || '').trim()).filter(Boolean)
      : (asin ? [String(asin).trim()].filter(Boolean) : []);
    
    console.log(`📥 [Target Seller Service] POST /api/sellers request alındı:`, {
      asin: asin,
      asinCount: asinList.length,
      targetMarketplace: targetMarketplace,
      scrapingMarketplace: scrapingMarketplace,
      targetCountry: targetCountry,
      bodyKeys: Object.keys(req.body)
    });
    
    if (asinList.length === 0) {
      console.warn(`⚠️ [Target Seller Service] ASIN eksik, 400 döndürülüyor`);
      return res.status(400).json({ 
        ok: false, 
        error: 'ASIN is required' 
      });
    }
    
    console.log(`📡 [Target Seller Service] Seller info request başlatılıyor: ${asinList[0]} (${asinList.length} ASIN) from ${scrapingMarketplace} (hedef pazar)`);
    console.log(`📊 [Target Queue] Queue durumu: ${requestQueue.running}/${requestQueue.maxConcurrent} çalışıyor, ${requestQueue.queue.length} bekliyor`);
    
    // KRİTİK: Queue'ya ekle - EAGAIN hatalarını önlemek için
    const result = await requestQueue.add(async () => {
      console.log(`🚀 [Target Queue] ${asinList[0]} (${asinList.length} ASIN) için hedef pazar seller bilgileri çekiliyor (${requestQueue.running}/${requestQueue.maxConcurrent}, queue: ${requestQueue.queue.length})`);
      try {
        if (asinList.length > 1) {
          // playwrightService'e scrapingMarketplace'i sourceMarketplace parametresi olarak geçiyoruz
          // çünkü playwrightService zaten sourceMarketplace parametresine göre URL oluşturuyor
          return await playwrightService.getSellerInfoBatch(asinList, scrapingMarketplace, targetCountry);
        }
        return await playwrightService.getSellerInfo(asinList[0], scrapingMarketplace, targetCountry);
      } catch (error) {
        const errorString = error.message || error.toString() || '';
        const isEAGAIN = error.isEAGAIN || 
                        errorString.includes('EAGAIN') || 
                        errorString.includes('Resource temporarily unavailable') ||
                        errorString.includes('spawn') ||
                        errorString.includes('Failed to launch');
        
        if (isEAGAIN) {
          console.error(`❌ [Target Queue] ${asinList[0]} için seller bilgileri EAGAIN hatası - Railway kaynak limiti aşıldı`);
          throw {
            ...error,
            isEAGAIN: true,
            message: `Railway kaynak limiti aşıldı (EAGAIN). Lütfen birkaç saniye bekleyip tekrar deneyin.`
          };
        }
        throw error;
      }
    });
    
    console.log(`📤 [Target Seller Service] Seller info response hazırlanıyor:`, {
      success: result.success,
      hasData: !!result.data,
      sellersCount: result.data?.sellers?.length || 0,
      itemsCount: result.data?.items?.length || 0,
      error: result.error || null
    });
    
    if (result.success) {
      // KRİTİK: hasNoSellers / pageNotFound flag'i varsa — ürün satışta değil veya hedef pazarda yok
      if (result.data?.hasNoSellers || result.data?.pageNotFound) {
        const reason = result.data?.pageNotFound ? 'PAGE NOT FOUND (ürün hedef pazarda yok)' : 'unavailable (satıcı yok)';
        console.log(`🚫 [Target Seller Service] ${asinList[0]} → ${reason} — DB'deki eski kayıtlar temizleniyor`);
        targetSellerDbService.deleteSellersForAsin(asinList[0], scrapingMarketplace)
          .catch(e => console.error(`❌ [TargetSellerDB] ${asinList[0]} eski kayıt silme hatası:`, e.message));
        return res.json({ ok: true, data: result.data });
      }
      
      // KRİTİK: Veri çekildi — HEMEN Target-Seller-Postgresql'e kaydet
      const sellersList = result.data?.sellers || result.data?.offers || [];
      if (sellersList.length > 0) {
        // Fire-and-forget — response'u geciktirmeden arka planda kaydet
        targetSellerDbService.saveSellers(asinList[0], scrapingMarketplace, targetCountry, sellersList)
          .catch(e => console.error(`❌ [TargetSellerDB] ${asinList[0]} kayıt hatası:`, e.message));
      }
      res.json({ ok: true, data: result.data });
    } else {
      res.status(result.status || 500).json({ 
        ok: false, 
        error: result.error || 'Failed to get target seller information' 
      });
    }
  } catch (error) {
    console.error(`❌ [Target Seller Service] Seller info error:`, error.message);
    next(error);
  }
});

/**
 * GET /api/sellers/db/:asin
 * DB'den kayıtlı target seller bilgilerini oku (Playwright çağırmadan)
 * KRİTİK: Bu route /:asin'den ÖNCE tanımlanmalı (Express route matching)
 */
router.get('/db/:asin', async (req, res) => {
  try {
    const { asin } = req.params;
    const { targetMarketplace } = req.query;
    
    if (!asin) {
      return res.status(400).json({ ok: false, error: 'ASIN is required' });
    }
    
    console.log(`📖 [Target Seller Service] DB read request: ${asin} (marketplace: ${targetMarketplace || 'all'})`);
    
    const sellers = await targetSellerDbService.getSellersForAsin(asin, targetMarketplace || null);
    
    console.log(`✅ [Target Seller Service] DB'den ${sellers.length} satıcı okundu: ${asin}`);
    
    return res.json({
      ok: true,
      asin,
      targetMarketplace: targetMarketplace || null,
      sellers: sellers.map(s => ({
        id: s.id,
        sellerName: s.sellerName,
        soldBy: s.soldBy,
        sellerId: s.sellerId,
        sellerRating: s.sellerRating,
        sellerRatingCount: s.sellerRatingCount,
        positivePercentage: s.positivePercentage,
        condition: s.condition,
        isNew: s.isNew,
        isUsed: s.isUsed,
        price: s.price,
        priceText: s.priceText,
        primePrice: s.primePrice || null,
        primePriceText: s.primePriceText || null,
        shipsFrom: s.shipsFrom,
        shippingPrice: s.shippingPrice,
        standardShippingPrice: s.standardShippingPrice,
        expressShippingPrice: s.expressShippingPrice,
        deliveryDate: s.deliveryDate,
        standardDeliveryDate: s.standardDeliveryDate,
        expressDeliveryDate: s.expressDeliveryDate,
        marketplace: s.marketplace || 'target',
        targetMarketplace: s.targetMarketplace,
        offerIndex: s.offerIndex,
        fetchedAt: s.fetchedAt
      })),
      totalSellers: sellers.length,
      source: 'target-seller-db-direct'
    });
  } catch (error) {
    console.error(`❌ [Target Seller Service] DB read error:`, error.message);
    return res.json({ ok: true, asin: req.params?.asin, sellers: [], totalSellers: 0, source: 'error' });
  }
});

/**
 * GET /api/sellers/:asin
 * Get TARGET marketplace seller information for a product using Playwright (GET method)
 */
router.get('/:asin', async (req, res, next) => {
  try {
    const { asin } = req.params;
    // KRİTİK FARK: marketplace parametresi = targetMarketplace (hedef pazar)
    const { marketplace = 'amazon.com', targetCountry } = req.query;
    const scrapingMarketplace = marketplace;
    
    if (!asin) {
      return res.status(400).json({ 
        ok: false, 
        error: 'ASIN is required' 
      });
    }
    
    console.log(`📡 [Target Seller Service] Seller info request (GET): ${asin} from ${scrapingMarketplace} (hedef pazar)`);
    console.log(`📊 [Target Queue] Queue durumu: ${requestQueue.running}/${requestQueue.maxConcurrent} çalışıyor, ${requestQueue.queue.length} bekliyor`);
    
    // KRİTİK: Queue'ya ekle - EAGAIN hatalarını önlemek için
    const result = await requestQueue.add(async () => {
      console.log(`🚀 [Target Queue] ${asin} için hedef pazar seller bilgileri çekiliyor (GET) (${requestQueue.running}/${requestQueue.maxConcurrent}, queue: ${requestQueue.queue.length})`);
      try {
        return await playwrightService.getSellerInfo(asin, scrapingMarketplace, targetCountry);
      } catch (error) {
        const errorString = error.message || error.toString() || '';
        const isEAGAIN = error.isEAGAIN || 
                        errorString.includes('EAGAIN') || 
                        errorString.includes('Resource temporarily unavailable') ||
                        errorString.includes('spawn') ||
                        errorString.includes('Failed to launch');
        
        if (isEAGAIN) {
          console.error(`❌ [Target Queue] ${asin} için seller bilgileri EAGAIN hatası (GET) - Railway kaynak limiti aşıldı`);
          throw {
            ...error,
            isEAGAIN: true,
            message: `Railway kaynak limiti aşıldı (EAGAIN). Lütfen birkaç saniye bekleyip tekrar deneyin.`
          };
        }
        throw error;
      }
    });
    
    if (result.success) {
      // KRİTİK: hasNoSellers / pageNotFound flag'i varsa — ürün satışta değil veya hedef pazarda yok (GET)
      if (result.data?.hasNoSellers || result.data?.pageNotFound) {
        const reason = result.data?.pageNotFound ? 'PAGE NOT FOUND' : 'unavailable';
        console.log(`🚫 [Target Seller Service] ${asin} → ${reason} — DB'deki eski kayıtlar temizleniyor (GET)`);
        targetSellerDbService.deleteSellersForAsin(asin, scrapingMarketplace)
          .catch(e => console.error(`❌ [TargetSellerDB] ${asin} eski kayıt silme hatası (GET):`, e.message));
        return res.json({ ok: true, data: result.data });
      }
      
      // KRİTİK: GET ile de veri çekildiğinde Target DB'ye kaydet
      const sellersList = result.data?.sellers || result.data?.offers || [];
      if (sellersList.length > 0) {
        targetSellerDbService.saveSellers(asin, scrapingMarketplace, targetCountry, sellersList)
          .catch(e => console.error(`❌ [TargetSellerDB] ${asin} kayıt hatası (GET):`, e.message));
      }
      res.json({ ok: true, data: result.data });
    } else {
      res.status(result.status || 500).json({ 
        ok: false, 
        error: result.error || 'Failed to get target seller information' 
      });
    }
  } catch (error) {
    console.error(`❌ [Target Seller Service] Seller info error:`, error.message);
    next(error);
  }
});

module.exports = router;
