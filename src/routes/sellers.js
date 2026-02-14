const express = require('express');
const router = express.Router();
const playwrightService = require('../services/playwrightService');
const sellerDbService = require('../services/sellerDbService');

// KRITIK: Queue mekanizmasi - EAGAIN hatalarini onlemek icin
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
      console.log(`⏳ [Queue] Son EAGAIN hatasindan ${Math.round(timeSinceLastEAGAIN/1000)}s gecti, ${Math.round(waitTime/1000)}s daha bekleniyor...`);
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
        console.log(`✅ [Queue] Basarili islem, EAGAIN sayaci sifirlaniyor`);
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
        console.error(`🚫 [Queue] EAGAIN hatasi (${this.eagainCount}. kez) - Railway kaynak limiti asildi.`);
        
        const baseDelay = 35000;
        exponentialDelay = Math.min(baseDelay * Math.pow(2, this.eagainCount - 1), 120000);
        
        console.error(`🚫 [Queue] ${Math.round(exponentialDelay/1000)} saniye bekleniyor (EAGAIN count: ${this.eagainCount})...`);
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
 * HEDEF PAZAR satici bilgilerini Playwright ile cek
 * KRITIK FARK: targetMarketplace parametresi kullanilir (sourceMarketplace degil)
 */
router.post('/', async (req, res, next) => {
  try {
    const { asin, asins, targetMarketplace = 'amazon.com', sourceMarketplace, targetCountry } = req.body;
    
    // Scraping icin kullanilacak marketplace: targetMarketplace (navbar secili ulke)
    const scrapingMarketplace = targetMarketplace || sourceMarketplace || 'amazon.com';
    
    const asinList = Array.isArray(asins)
      ? asins.map(a => String(a || '').trim()).filter(Boolean)
      : (asin ? [String(asin).trim()].filter(Boolean) : []);
    
    console.log(`📥 [Target Seller] POST /api/sellers request alindi:`, {
      asin: asin,
      asinCount: asinList.length,
      targetMarketplace: targetMarketplace,
      scrapingMarketplace: scrapingMarketplace,
      targetCountry: targetCountry,
      bodyKeys: Object.keys(req.body),
      hasAsin: asinList.length > 0
    });
    
    if (asinList.length === 0) {
      console.warn(`⚠️ [Target Seller] ASIN eksik, 400 donduruluyor`);
      return res.status(400).json({ 
        ok: false, 
        error: 'ASIN is required' 
      });
    }
    
    console.log(`📡 [Target Seller] Seller info request baslatiliyor: ${asinList[0]} (${asinList.length} ASIN) from ${scrapingMarketplace} (HEDEF PAZAR)`);
    console.log(`📊 [Queue] Queue durumu: ${requestQueue.running}/${requestQueue.maxConcurrent} calisiyor, ${requestQueue.queue.length} bekliyor`);
    
    // KRITIK: Queue'ya ekle
    const result = await requestQueue.add(async () => {
      console.log(`🚀 [Queue] ${asinList[0]} (${asinList.length} ASIN) icin HEDEF PAZAR seller bilgileri cekiliyor (${requestQueue.running}/${requestQueue.maxConcurrent}, queue: ${requestQueue.queue.length})`);
      try {
        if (asinList.length > 1) {
          // scrapingMarketplace'i sourceMarketplace olarak gec (playwrightService bu parametreyi kullaniyor)
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
          console.error(`❌ [Queue] ${asinList[0]} icin seller bilgileri EAGAIN hatasi`);
          throw {
            ...error,
            isEAGAIN: true,
            message: `Railway kaynak limiti asildi (EAGAIN). Lutfen birkac saniye bekleyip tekrar deneyin.`
          };
        }
        throw error;
      }
    });
    
    console.log(`📤 [Target Seller] Seller info response hazirlaniyor:`, {
      success: result.success,
      hasData: !!result.data,
      sellersCount: result.data?.sellers?.length || 0,
      itemsCount: result.data?.items?.length || 0,
      error: result.error || null
    });
    
    if (result.success) {
      // KRITIK: Veri cekildi — HEMEN TargetSeller tablosuna kaydet
      const sellersList = result.data?.sellers || result.data?.offers || [];
      if (sellersList.length > 0) {
        sellerDbService.saveSellers(asinList[0], scrapingMarketplace, targetCountry, sellersList)
          .catch(e => console.error(`❌ [TargetSellerDB] ${asinList[0]} kayit hatasi:`, e.message));
      }
      res.json({ ok: true, data: result.data });
    } else {
      res.status(result.status || 500).json({ 
        ok: false, 
        error: result.error || 'Failed to get seller information' 
      });
    }
  } catch (error) {
    console.error(`❌ [Target Seller] Seller info error:`, error.message);
    next(error);
  }
});

/**
 * GET /api/sellers/:asin
 * HEDEF PAZAR satici bilgilerini Playwright ile cek (GET method)
 */
router.get('/:asin', async (req, res, next) => {
  try {
    const { asin } = req.params;
    const { marketplace = 'amazon.com', targetMarketplace, targetCountry } = req.query;
    
    // targetMarketplace oncelikli, yoksa marketplace kullan
    const scrapingMarketplace = targetMarketplace || marketplace || 'amazon.com';
    
    if (!asin) {
      return res.status(400).json({ 
        ok: false, 
        error: 'ASIN is required' 
      });
    }
    
    console.log(`📡 [Target Seller] Seller info request (GET): ${asin} from ${scrapingMarketplace} (HEDEF PAZAR)`);
    console.log(`📊 [Queue] Queue durumu: ${requestQueue.running}/${requestQueue.maxConcurrent} calisiyor, ${requestQueue.queue.length} bekliyor`);
    
    const result = await requestQueue.add(async () => {
      console.log(`🚀 [Queue] ${asin} icin HEDEF PAZAR seller bilgileri cekiliyor (GET) (${requestQueue.running}/${requestQueue.maxConcurrent}, queue: ${requestQueue.queue.length})`);
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
          console.error(`❌ [Queue] ${asin} icin seller bilgileri EAGAIN hatasi (GET)`);
          throw {
            ...error,
            isEAGAIN: true,
            message: `Railway kaynak limiti asildi (EAGAIN). Lutfen birkac saniye bekleyip tekrar deneyin.`
          };
        }
        throw error;
      }
    });
    
    if (result.success) {
      const sellersList = result.data?.sellers || result.data?.offers || [];
      if (sellersList.length > 0) {
        sellerDbService.saveSellers(asin, scrapingMarketplace, targetCountry, sellersList)
          .catch(e => console.error(`❌ [TargetSellerDB] ${asin} kayit hatasi (GET):`, e.message));
      }
      res.json({ ok: true, data: result.data });
    } else {
      res.status(result.status || 500).json({ 
        ok: false, 
        error: result.error || 'Failed to get seller information' 
      });
    }
  } catch (error) {
    console.error(`❌ [Target Seller] Seller info error:`, error.message);
    next(error);
  }
});

module.exports = router;
