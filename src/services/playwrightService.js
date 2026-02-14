// Playwright Service - Seller Information Extraction
const { chromium } = require('playwright');

class PlaywrightService {
  constructor() {
    console.log('✅ [Seller Playwright] Initializing (10 sekme, browser bir kere — vixify-playwright-service-batch mantığı)...');
    this.browser = null;
    this.browserLaunchPromise = null;
    this.contexts = new Map();
    this.contextSetupStatus = new Map();
    this.pagePools = new Map();
    this.pagePoolIndex = new Map();
    this.pagePoolSize = 10;
    this._currentAsin = '';
  }

  /** Log prefix — hangi ASIN işleniyorsa otomatik eklenir */
  get _tag() {
    return this._currentAsin ? `[Playwright][${this._currentAsin}]` : '[Playwright]';
  }

  getContextKey(sourceMarketplace, targetCountryCode) {
    return `${sourceMarketplace}_${targetCountryCode || 'default'}`;
  }

  async getBrowser() {
    const globalInstall = global.__browserInstallationPromise;
    if (globalInstall) {
      try { await globalInstall; } catch (e) { console.warn('⚠️ [Seller Playwright] Tarayıcı kurulum beklemesi hatası:', e.message); }
    }
    if (this.browser) {
      try {
        if (this.browser.isConnected()) return this.browser;
        this.browser = null;
      } catch (e) { this.browser = null; }
    }
    if (this.browserLaunchPromise) return await this.browserLaunchPromise;
    this.browserLaunchPromise = this._launchBrowser();
    try {
      this.browser = await this.browserLaunchPromise;
      return this.browser;
    } finally {
      this.browserLaunchPromise = null;
    }
  }

  async _launchBrowser() {
    console.log('🌐 [Seller Playwright] Browser başlatılıyor (bir kere, reuse edilecek)...');
    const opts = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled', '--single-process', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      timeout: 60000
    };
    const browser = await chromium.launch(opts);
    console.log('✅ [Seller Playwright] Browser başlatıldı (reuse için açık kalacak)');
    return browser;
  }

  async getOrCreateContext(sourceMarketplace, targetCountryCode) {
    const key = this.getContextKey(sourceMarketplace, targetCountryCode);
    if (this.contexts.has(key)) {
      const ctx = this.contexts.get(key);
      try {
        if (ctx && ctx.browser() && ctx.browser().isConnected()) {
          ctx.pages();
          if (this.contextSetupStatus.get(key)) {
            console.log(`♻️ [Seller Playwright] Context reuse: ${key}`);
            return ctx;
          }
        }
      } catch (e) { /* invalid */ }
      this.contexts.delete(key);
      this.contextSetupStatus.delete(key);
      this.pagePools.delete(key);
      this.pagePoolIndex.delete(key);
    }
    const browser = await this.getBrowser();
    console.log(`📄 [Seller Playwright] Context oluşturuluyor: ${key}`);
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    const marketplaceDomain = { 'amazon.com': 'www.amazon.com', 'amazon.co.uk': 'www.amazon.co.uk', 'amazon.de': 'www.amazon.de', 'amazon.es': 'www.amazon.es', 'amazon.it': 'www.amazon.it', 'amazon.fr': 'www.amazon.fr', 'amazon.co.jp': 'www.amazon.co.jp' };
    const baseUrl = `https://${marketplaceDomain[sourceMarketplace] || 'www.amazon.com'}`;

    // KRİTİK: targetCountry yoksa setup atla — direkt AOD'a gidilecek, Amazon ana sayfa yüklemesi gereksiz (timeout/captcha riski)
    if (!targetCountryCode) {
      console.log(`⚡ [Seller Playwright] targetCountry yok, setup atlanıyor — direkt AOD kullanılacak`);
    } else {
      const setupPage = await context.newPage();
      console.log(`🌐 [Seller Playwright] Setup sayfası açılıyor: ${baseUrl}`);
      try {
        await setupPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        console.log(`✅ [Seller Playwright] Setup sayfası yüklendi`);
      } catch (gotoErr) {
        console.error(`❌ [Seller Playwright] Setup sayfası yükleme hatası: ${gotoErr.message}`);
        await setupPage.close().catch(() => {});
        throw gotoErr;
      }
      await this.safeWait(setupPage, 2000);
      console.log(`🌍 [Seller Playwright] Ülke ve para birimi seçimi başlatılıyor: ${targetCountryCode}`);
      const res = await this.selectCountryAndCurrency(setupPage, targetCountryCode, sourceMarketplace, baseUrl);
      if (!res.success) console.warn('⚠️ [Seller Playwright] Context ülke seçimi başarısız:', res.error);
      else console.log(`✅ [Seller Playwright] Ülke/para birimi seçimi tamamlandı`);
      await setupPage.close().catch(() => {});
    }
    this.contexts.set(key, context);
    this.contextSetupStatus.set(key, true);
    console.log(`✅ [Seller Playwright] Yeni context: ${key}`);
    return context;
  }

  async getPagePool(sourceMarketplace, targetCountryCode) {
    const key = this.getContextKey(sourceMarketplace, targetCountryCode);
    if (this.pagePools.has(key)) {
      const pages = (this.pagePools.get(key) || []).filter(p => p && !p.isClosed());
      if (pages.length === this.pagePoolSize) {
        console.log(`♻️ [Seller Playwright] Page pool reuse: ${key} (${pages.length} sekme)`);
        return pages;
      }
      (this.pagePools.get(key) || []).forEach(p => p.close().catch(() => {}));
    }
    const ctx = await this.getOrCreateContext(sourceMarketplace, targetCountryCode);
    const pages = [];
    for (let i = 0; i < this.pagePoolSize; i++) {
      pages.push(await ctx.newPage());
    }
    this.pagePools.set(key, pages);
    this.pagePoolIndex.set(key, 0);
    console.log(`✅ [Seller Playwright] ${this.pagePoolSize} sekme açıldı: ${key}`);
    return pages;
  }

  getNextPage(pages, key) {
    let idx = this.pagePoolIndex.get(key) || 0;
    const page = pages[idx];
    this.pagePoolIndex.set(key, (idx + 1) % this.pagePoolSize);
    return page;
  }

  /**
   * Safe wait function - checks if page is still valid before waiting
   */
  async safeWait(page, ms) {
    try {
      if (page && !page.isClosed()) {
        await page.waitForTimeout(ms);
      }
    } catch (e) {
      console.warn(`⚠️ ${this._tag} Safe wait error: ${e.message}`);
    }
  }

  /**
   * Get country name from country code
   */
  getCountryName(countryCode) {
    const map = {
      'US': 'United States',
      'USA': 'United States',
      'UK': 'United Kingdom',
      'GB': 'United Kingdom',
      'DE': 'Germany',
      'FR': 'France',
      'IT': 'Italy',
      'ES': 'Spain',
      'NL': 'Netherlands',
      'BE': 'Belgium',
      'SE': 'Sweden',
      'PL': 'Poland',
      'IE': 'Ireland',
      'TR': 'Turkey',
      'JP': 'Japan',
      'CN': 'China',
      'IN': 'India',
      'AU': 'Australia',
      'SG': 'Singapore',
      'AE': 'United Arab Emirates',
      'SA': 'Saudi Arabia',
      'EG': 'Egypt',
      'BR': 'Brazil',
      'CA': 'Canada',
      'MX': 'Mexico'
    };
    return map[countryCode] || countryCode;
  }

  /**
   * Convert navbar country code to Amazon country code
   * KRİTİK: amazon.co.uk, amazon.de gibi domain'ler de kabul edilir
   */
  convertToAmazonCountryCode(countryCode) {
    if (!countryCode || typeof countryCode !== 'string') return 'US';
    const raw = countryCode.toString().trim().toLowerCase();
    const map = {
      'usa': 'US', 'us': 'US', 'america': 'US', 'united states': 'US',
      'uk': 'GB', 'gb': 'GB', 'germany': 'DE', 'de': 'DE', 'france': 'FR', 'fr': 'FR',
      'italy': 'IT', 'it': 'IT', 'spain': 'ES', 'es': 'ES', 'japan': 'JP', 'jp': 'JP',
      'canada': 'CA', 'ca': 'CA', 'australia': 'AU', 'au': 'AU',
      'netherlands': 'NL', 'nl': 'NL', 'belgium': 'BE', 'be': 'BE',
      'singapore': 'SG', 'sg': 'SG', 'mexico': 'MX', 'mx': 'MX',
      'amazon.com': 'US', 'amazon.co.uk': 'GB', 'amazon.de': 'DE', 'amazon.fr': 'FR',
      'amazon.it': 'IT', 'amazon.es': 'ES', 'amazon.co.jp': 'JP', 'amazon.ca': 'CA'
    };
    return map[raw] || (raw.length === 2 ? raw.toUpperCase() : 'US');
  }

  /**
   * Select country and currency using Playwright (from other Playwright service)
   * @param {Object} page - Playwright page object
   * @param {string} targetCountryCode - Target country code (US, UK, DE, etc.)
   * @param {string} sourceMarketplace - Source marketplace (amazon.com, amazon.de, etc.)
   * @param {string} asinUrl - ASIN URL (optional)
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  async selectCountryAndCurrency(page, targetCountryCode, sourceMarketplace = 'amazon.com', asinUrl = null) {
    try {
      // Navbar'dan gelen country code'u Amazon country code'a çevir
      const amazonCountryCode = this.convertToAmazonCountryCode(targetCountryCode);
      const targetCountryName = this.getCountryName(amazonCountryCode);
      console.log(`🎭 ${this._tag} Ülke seçimi başlatılıyor: ${targetCountryCode} -> ${amazonCountryCode} (${targetCountryName})`);

      // KRİTİK: Kaynak marketplace zaten hedef ülkeyse ülke seçimini atla (amazon.co.uk + uk gibi)
      const marketplaceToCountry = {
        'amazon.com': 'US', 'amazon.co.uk': 'GB', 'amazon.de': 'DE', 'amazon.fr': 'FR',
        'amazon.it': 'IT', 'amazon.es': 'ES', 'amazon.co.jp': 'JP', 'amazon.ca': 'CA'
      };
      const sourceCountry = marketplaceToCountry[sourceMarketplace];
      const isLocalMarketplace = sourceCountry && amazonCountryCode === sourceCountry;
      if (isLocalMarketplace) {
        console.log(`📍 ${this._tag} Yerel marketplace (${sourceMarketplace} = ${amazonCountryCode}), posta kodu ile adres ayarlanacak — ATLANMIYOR`);
      }
      
      // Para birimi seçimi - Kaynak mağazaya göre para birimi seçilmeli
      const marketplaceCurrency = {
        'amazon.com': 'USD',
        'amazon.co.uk': 'GBP',
        'amazon.de': 'EUR',
        'amazon.es': 'EUR',
        'amazon.it': 'EUR',
        'amazon.fr': 'EUR',
        'amazon.co.jp': 'JPY'
      };
      
      const targetCurrency = marketplaceCurrency[sourceMarketplace] || 'USD';
      console.log(`💵 ${this._tag} Para birimi seçimi başlatılıyor: ${targetCurrency} (source: ${sourceMarketplace})`);
      
      // Marketplace domain mapping
      const marketplaceDomain = {
        'amazon.com': 'www.amazon.com',
        'amazon.co.uk': 'www.amazon.co.uk',
        'amazon.de': 'www.amazon.de',
        'amazon.es': 'www.amazon.es',
        'amazon.it': 'www.amazon.it',
        'amazon.fr': 'www.amazon.fr',
        'amazon.co.jp': 'www.amazon.co.jp'
      };
      
      const baseDomain = marketplaceDomain[sourceMarketplace] || 'www.amazon.com';
      const baseUrl = `https://${baseDomain}`;
      console.log(`🌐 ${this._tag} Marketplace domain: ${baseUrl} (source: ${sourceMarketplace})`);
      
      // KRİTİK: Sayfa yüklendikten sonra ekstra bekleme - kısaltıldı
      await this.safeWait(page, 1000); // 3s -> 1s
      console.log(`⏳ ${this._tag} Sayfa yükleme sonrası bekleme tamamlandı, captcha kontrolü yapılıyor...`);

      // KRİTİK: Amazon captcha sayfası kontrolü - eğer captcha sayfasındaysa "Continue shopping" butonuna tıkla
      try {
        // Captcha sayfası göstergeleri - birden fazla kontrol
        const currentUrl = page.url();
        const isCaptchaPage = currentUrl.includes('/errors/validateCaptcha');
        const captchaForm = await page.$('form[action="/errors/validateCaptcha"]').catch(() => null);
        
        // Continue shopping butonunu bul - farklı selector'lar dene
        let continueShoppingButton = null;
        const buttonSelectors = [
          'button[alt="Continue shopping"]',
          'form[action="/errors/validateCaptcha"] button[type="submit"]',
          'form[action="/errors/validateCaptcha"] button',
          'button:has-text("Continue shopping")',
          'button[type="submit"]'
        ];
        
        for (const selector of buttonSelectors) {
          try {
            continueShoppingButton = await page.$(selector).catch(() => null);
            if (continueShoppingButton) {
              const buttonText = await continueShoppingButton.textContent().catch(() => '');
              if (buttonText && (buttonText.includes('Continue') || buttonText.includes('shopping') || selector.includes('submit'))) {
                console.log(`✅ ${this._tag} Continue shopping butonu bulundu: ${selector}`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        // Text içeriğini de kontrol et
        const captchaText = await page.textContent('body').catch(() => '');
        const hasCaptchaText = captchaText.includes('Click the button below to continue shopping') || 
                              captchaText.includes('continue shopping') ||
                              captchaText.includes('Continue shopping');
        
        if (captchaForm || isCaptchaPage || continueShoppingButton || hasCaptchaText) {
          console.log(`⚠️ ${this._tag} Amazon captcha sayfası tespit edildi (form: ${!!captchaForm}, URL: ${isCaptchaPage}, button: ${!!continueShoppingButton}, text: ${hasCaptchaText}), "Continue shopping" butonuna tıklanıyor...`);
          
          if (continueShoppingButton) {
            try {
              await continueShoppingButton.scrollIntoViewIfNeeded();
              await this.safeWait(page, 500);
              await continueShoppingButton.click({ timeout: 30000 });
              console.log(`✅ ${this._tag} "Continue shopping" butonuna tıklandı, sayfa yüklenmesi bekleniyor...`);
              
              // Sayfa yüklenmesini bekle - timeout kısaltıldı
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { // 30s -> 10s
                console.warn(`⚠️ ${this._tag} Network idle bekleme timeout, devam ediliyor...`);
              });
              await this.safeWait(page, 2000); // 5s -> 2s
              
              // Sayfa URL'ini tekrar kontrol et - eğer hala captcha sayfasındaysa tekrar dene
              const newUrl = page.url();
              if (newUrl.includes('/errors/validateCaptcha')) {
                console.warn(`⚠️ ${this._tag} Hala captcha sayfasında, tekrar deneniyor...`);
                await this.safeWait(page, 3000);
                
                // Tekrar butonu bul ve tıkla
                for (const selector of buttonSelectors) {
                  try {
                    const retryButton = await page.$(selector).catch(() => null);
                    if (retryButton) {
                      const buttonText = await retryButton.textContent().catch(() => '');
                      if (buttonText && (buttonText.includes('Continue') || buttonText.includes('shopping'))) {
                        await retryButton.click({ timeout: 30000 });
                        await this.safeWait(page, 5000);
                        console.log(`✅ ${this._tag} Retry butonuna tıklandı`);
                        break;
                      }
                    }
                  } catch (e) {
                    continue;
                  }
                }
              } else {
                console.log(`✅ ${this._tag} Captcha sayfasından çıkıldı, normal sayfaya yönlendirildi: ${newUrl}`);
              }
            } catch (captchaClickError) {
              console.warn(`⚠️ ${this._tag} Captcha butonuna tıklama hatası: ${captchaClickError.message}`);
              // JavaScript ile tıklamayı dene
              try {
                const clicked = await page.evaluate(() => {
                  const form = document.querySelector('form[action="/errors/validateCaptcha"]');
                  if (form) {
                    const btn = form.querySelector('button[type="submit"]') || 
                               form.querySelector('button');
                    if (btn) {
                      btn.click();
                      return true;
                    }
                  }
                  return false;
                });
                if (clicked) {
                  await this.safeWait(page, 5000);
                  console.log(`✅ ${this._tag} Captcha butonuna JavaScript ile tıklandı`);
                }
              } catch (jsError) {
                console.warn(`⚠️ ${this._tag} JavaScript click de başarısız: ${jsError.message}`);
              }
            }
          } else if (captchaForm || isCaptchaPage) {
            // Buton bulunamadı ama captcha sayfasındayız, form submit et
            console.warn(`⚠️ ${this._tag} Continue shopping butonu bulunamadı, form submit deneniyor...`);
            try {
              await page.evaluate(() => {
                const form = document.querySelector('form[action="/errors/validateCaptcha"]');
                if (form) form.submit();
              });
              await this.safeWait(page, 5000);
              console.log(`✅ ${this._tag} Captcha formu submit edildi`);
            } catch (submitError) {
              console.warn(`⚠️ ${this._tag} Form submit hatası: ${submitError.message}`);
            }
          }
        } else {
          console.log(`ℹ️ ${this._tag} Captcha sayfası tespit edilmedi, normal akışa devam ediliyor...`);
        }
      } catch (captchaCheckError) {
        // Captcha kontrolü başarısız, normal akışa devam et
        console.log(`ℹ️ ${this._tag} Captcha kontrolü yapılamadı, normal akışa devam ediliyor: ${captchaCheckError.message}`);
      }

      // "Deliver to" butonunu bul ve tıkla - DOM Path: #nav-global-location-popover-link
      // KRİTİK: Sayfa yüklendikten sonra ekstra bekleme - kısaltıldı
      await this.safeWait(page, 1000); // 3s -> 1s
      console.log(`⏳ ${this._tag} Sayfa yükleme sonrası ekstra bekleme tamamlandı, "Deliver to" butonu aranıyor...`);
      
      // Network idle olmasını bekle (sayfa tam yüklensin) - timeout'u kısalt
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { // 10s -> 5s
          console.warn(`⚠️ ${this._tag} Network idle bekleme timeout, devam ediliyor...`);
        });
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Network idle hatası: ${e.message}`);
      }
      await this.safeWait(page, 1000); // 3s -> 1s
      
      // KRİTİK: Sayfa title'ını kontrol et - eğer "Amazon.com" ise sayfa tam yüklenmemiş olabilir
      let pageTitle = await page.title().catch(() => '');
      let retryCount = 0;
      const maxTitleRetries = 3;
      
      // KRİTİK: Retry mekanizmasını kaldır - çok uzun sürüyor, sadece 1 kez kontrol et
      if (pageTitle === 'Amazon.com' || pageTitle === 'Amazon' || !pageTitle) {
        console.warn(`⚠️ ${this._tag} Sayfa title sadece "Amazon.com" - sayfa tam yüklenmemiş olabilir, ekstra bekleme...`);
        await this.safeWait(page, 2000); // 5s -> 2s
        
        // Sayfayı yeniden yükle (sadece 1 kez)
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); // 60s -> 30s
          await this.safeWait(page, 2000); // 5s -> 2s
          console.log(`✅ ${this._tag} Sayfa yeniden yüklendi`);
          
          // Title'ı tekrar kontrol et
          pageTitle = await page.title().catch(() => '');
          if (pageTitle !== 'Amazon.com' && pageTitle !== 'Amazon' && pageTitle) {
            console.log(`✅ ${this._tag} Sayfa title düzeldi: "${pageTitle}"`);
          }
        } catch (reloadError) {
          console.warn(`⚠️ ${this._tag} Sayfa reload hatası: ${reloadError.message}`);
        }
      }
      
      // KRİTİK: Eğer hala title "Amazon.com" ise, sayfanın tam yüklenmesi için ekstra bekleme - kısaltıldı
      if (pageTitle === 'Amazon.com' || pageTitle === 'Amazon' || !pageTitle) {
        console.warn(`⚠️ ${this._tag} Sayfa title hala "Amazon.com" - sayfa tam yüklenmemiş olabilir, ekstra bekleme ve scroll...`);
        await this.safeWait(page, 3000); // 10s -> 3s
        
        // Sayfayı scroll et - navbar'ın yüklenmesi için
        try {
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
          await this.safeWait(page, 1000); // 2s -> 1s
          await page.evaluate(() => {
            window.scrollTo(0, 100);
          });
          await this.safeWait(page, 1000); // 2s -> 1s
          console.log(`✅ ${this._tag} Sayfa scroll edildi (navbar yüklenmesi için)`);
        } catch (scrollError) {
          console.warn(`⚠️ ${this._tag} Scroll hatası: ${scrollError.message}`);
        }
      }
      
      console.log(`🎭 ${this._tag} "Deliver to" butonu aranıyor...`);
      const deliverToSelectors = [
        '#nav-global-location-popover-link', // Öncelikli selector (tüm Amazon sitelerinde aynı)
        'a#nav-global-location-popover-link',
        'span#nav-global-location-popover-link',
        'a[data-csa-c-type="button"][id*="nav-global-location"]',
        'a[id*="nav-global-location"]',
        'span[id*="nav-global-location"]',
        'a[aria-label*="Deliver to"]',
        'span[aria-label*="Deliver to"]',
        'a[aria-label*="Lieferung"]',
        'span[aria-label*="Lieferung"]',
        'a[aria-label*="Livraison"]',
        'span[aria-label*="Livraison"]',
        'a[aria-label*="Envío"]',
        'span[aria-label*="Envío"]',
        'a[aria-label*="Spedizione"]',
        'span[aria-label*="Spedizione"]',
        'a:has-text("Deliver to")',
        'span:has-text("Deliver to")',
        '#nav-global-location-slot',
        '[data-csa-c-slot-id="nav-global-location"]',
        'a[href*="glow=change-country"]',
        'span[data-action="a-popover-trigger"]',
        // Fallback: PDP içindeki delivery/location tetikleyicileri (navbar bazen render olmuyor)
        '#contextualIngressPt',
        '#contextualIngressPtLabel',
        '#contextualIngressPtLabel_deliveryShortLine',
        '#contextualIngressPtLabel_deliveryLongLine',
        '[data-action*="GLUX"]'
      ];
      
      let deliverToButton = null;
      let foundSelector = null;
      
      // Önce tüm selector'ları dene (visible olmasa bile)
      for (const selector of deliverToSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            const isVisible = await element.isVisible().catch(() => false);
            if (isVisible) {
              deliverToButton = element;
              foundSelector = selector;
              console.log(`✅ ${this._tag} "Deliver to" butonu bulundu (visible): ${selector}`);
              break;
            } else {
              // Visible değilse de sakla, belki scroll ile görünür olur
              if (!deliverToButton) {
                deliverToButton = element;
                foundSelector = selector;
                console.log(`⚠️ ${this._tag} "Deliver to" butonu bulundu (hidden): ${selector}`);
              }
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      // Eğer hala bulunamadıysa, waitForSelector ile bekle
      if (!deliverToButton) {
        console.log(`⏳ ${this._tag} "Deliver to" butonu hemen bulunamadı, bekleniyor...`);
        
        // KRİTİK: Sayfayı scroll et - navbar'ın görünür olması için
        try {
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
          await this.safeWait(page, 2000);
          console.log(`✅ ${this._tag} Sayfa scroll edildi (navbar görünürlüğü için)`);
        } catch (scrollError) {
          console.warn(`⚠️ ${this._tag} Scroll hatası: ${scrollError.message}`);
        }
        
        for (const selector of deliverToSelectors.slice(0, 5)) { // İlk 5 selector'ı bekle
          try {
            await page.waitForSelector(selector, { timeout: 20000, state: 'attached' });
            deliverToButton = await page.$(selector);
            if (deliverToButton) {
              foundSelector = selector;
              console.log(`✅ ${this._tag} "Deliver to" butonu beklenerek bulundu: ${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      // KRİTİK: Eğer hala bulunamadıysa, sayfanın tam yüklenmesi için ekstra bekleme ve tekrar dene
      if (!deliverToButton) {
        console.log(`⏳ ${this._tag} "Deliver to" butonu hala bulunamadı, sayfa tam yüklenmesi için ekstra bekleme...`);
        
        // KRİTİK: Navbar'ın render olması için sayfayı scroll et ve bekle
        try {
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
          await this.safeWait(page, 2000);
          
          // Navbar container'ının yüklenmesini bekle
          try {
            await page.waitForSelector('#nav-global-location-slot, #nav-belt, #navbar', { 
              timeout: 15000, 
              state: 'attached' 
            });
            console.log(`✅ ${this._tag} Navbar container yüklendi`);
          } catch (e) {
            console.warn(`⚠️ ${this._tag} Navbar container bekleme timeout`);
          }
          
          await this.safeWait(page, 3000);
          
          // JavaScript ile navbar'ı kontrol et
          const navbarExists = await page.evaluate(() => {
            const navbar = document.querySelector('#nav-global-location-popover-link');
            return navbar !== null;
          });
          
          if (navbarExists) {
            console.log(`✅ ${this._tag} Navbar JavaScript ile tespit edildi, tekrar aranıyor...`);
          }
        } catch (scrollError) {
          console.warn(`⚠️ ${this._tag} Scroll/check hatası: ${scrollError.message}`);
        }
        
        await this.safeWait(page, 5000);
        
        // Tüm selector'ları tekrar dene
        try {
          for (const selector of deliverToSelectors) {
            try {
              const element = await page.$(selector);
              if (element) {
                const isVisible = await element.isVisible().catch(() => false);
                if (isVisible || !deliverToButton) {
                  deliverToButton = element;
                  foundSelector = selector;
                  console.log(`✅ ${this._tag} "Deliver to" butonu ekstra bekleme sonrası bulundu: ${selector}`);
                  break;
                }
              }
            } catch (e) {
              continue;
            }
          }
        } catch (retryError) {
          console.warn(`⚠️ ${this._tag} Ekstra bekleme ve retry hatası: ${retryError.message}`);
        }
      }
      
      // Son çare: Sayfa içeriğinde "Deliver to" (veya dil karşılığı) text'ini ara
      if (!deliverToButton) {
        const deliverToTexts = ['Deliver to', 'Lieferung an', 'Livraison à', 'Envío a', 'Spedizione a', '配達先'];
        console.log(`🔍 ${this._tag} "Deliver to" butonu selector'larla bulunamadı, sayfa içeriğinde aranıyor...`);
        try {
          const allLinks = await page.$$('a, span, button');
          for (const link of allLinks) {
            try {
              const text = (await link.textContent()) || '';
              const ariaLabel = (await link.getAttribute('aria-label')) || '';
              const combined = `${text} ${ariaLabel}`;
              if (deliverToTexts.some(t => combined.includes(t))) {
                deliverToButton = link;
                foundSelector = 'text-content-search';
                console.log(`✅ ${this._tag} "Deliver to" butonu text içeriğinden bulundu`);
                break;
              }
            } catch (e) {
              continue;
            }
          }
        } catch (e) {
          console.warn(`⚠️ ${this._tag} Text içeriği arama hatası: ${e.message}`);
        }
      }
      
      if (!deliverToButton) {
        // Sayfa screenshot al (debug için)
        try {
          const screenshot = await page.screenshot({ fullPage: false });
          console.error(`❌ ${this._tag} Sayfa screenshot alındı (Deliver to butonu bulunamadı)`);
        } catch (e) {
          console.warn(`⚠️ ${this._tag} Screenshot alınamadı: ${e.message}`);
        }
        
        // Sayfa HTML'inin bir kısmını logla
        try {
          const bodyHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
          console.error(`❌ ${this._tag} Sayfa HTML (ilk 5000 karakter):`, bodyHTML);
        } catch (e) {
          console.warn(`⚠️ ${this._tag} HTML alınamadı: ${e.message}`);
        }
        
        throw new Error(`Deliver to button not found after exhaustive search. Page title: "${await page.title()}"`);
      }
      
      // "Deliver to" butonuna tıkla
      try {
        // Butonun görünür olmasını sağla
        const isVisible = await deliverToButton.isVisible().catch(() => false);
        if (!isVisible) {
          console.log(`⚠️ ${this._tag} "Deliver to" butonu görünür değil, scroll yapılıyor...`);
          await deliverToButton.scrollIntoViewIfNeeded();
          await this.safeWait(page, 2000);
        }
        
        // Butonun tıklanabilir olmasını bekle
        await page.waitForSelector(foundSelector || deliverToSelectors[0], { 
          timeout: 10000, 
          state: 'visible' 
        }).catch(() => {
          console.warn(`⚠️ ${this._tag} Buton visible state bekleme timeout, devam ediliyor...`);
        });
        
        await this.safeWait(page, 1000);
        
        // Normal click dene
        try {
          await deliverToButton.click({ timeout: 30000 });
          console.log(`✅ ${this._tag} "Deliver to" butonuna tıklandı (normal click)`);
        } catch (normalClickError) {
          console.warn(`⚠️ ${this._tag} Normal click başarısız, force click deneniyor: ${normalClickError.message}`);
          await deliverToButton.click({ force: true, timeout: 30000 });
          console.log(`✅ ${this._tag} "Deliver to" butonuna tıklandı (force click)`);
        }
        
        await this.safeWait(page, 3000);
      } catch (clickError) {
        console.error(`❌ ${this._tag} "Deliver to" butonuna tıklama hatası: ${clickError.message}`);
        // JavaScript ile click dene
        try {
          await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            if (element) {
              element.click();
            }
          }, foundSelector || deliverToSelectors[0]);
          console.log(`✅ ${this._tag} "Deliver to" butonuna JavaScript ile tıklandı`);
          await this.safeWait(page, 3000);
        } catch (jsClickError) {
          throw new Error(`Deliver to button click failed: ${clickError.message}. JS click also failed: ${jsClickError.message}`);
        }
      }
      
      // Popover açılmasını bekle
      console.log(`🎭 ${this._tag} Popover açılması bekleniyor...`);
      // KRİTİK: Popover açılmasını bekle (#a-popover-3 veya #a-popover-4) - timeout kısaltıldı
      try {
        await page.waitForSelector('#a-popover-3, #a-popover-4, .a-popover-wrapper, #GLUX_Popover', { timeout: 5000, state: 'visible' }); // 15s -> 5s
        console.log(`✅ ${this._tag} Popover açıldı`);
      } catch (popoverError) {
        console.warn(`⚠️ ${this._tag} Popover selector bulunamadı, devam ediliyor...`);
      }
      await this.safeWait(page, 1000); // 2s -> 1s
      
      // KRİTİK: Yerel marketplace ise posta kodu gir, ülke dropdown'u kullanma
      let postcodeSetSuccessfully = false;
      if (isLocalMarketplace) {
        const marketplacePostcodes = {
          'amazon.co.uk': 'N1 3QP',
          'amazon.de': '10115',
          'amazon.fr': '75001',
          'amazon.it': '00100',
          'amazon.es': '28001',
          'amazon.co.jp': '100-0001',
          'amazon.com': '10001',
          'amazon.ca': 'M5V 2T6'
        };
        const postcode = marketplacePostcodes[sourceMarketplace] || '';
        console.log(`📮 ${this._tag} Posta kodu ile adres ayarlanıyor: "${postcode}" (${sourceMarketplace})`);
        
        if (postcode) {
          try {
            // Posta kodu input alanını bul
            let postcodeInput = null;
            const postcodeInputSelectors = [
              '#GLUXZipUpdateInput',
              'input#GLUXZipUpdateInput',
              'input[aria-label*="postcode"]',
              'input[aria-label*="postal"]',
              'input[aria-label*="ZIP"]',
              'input[autocomplete="postal-code"]'
            ];
            for (const sel of postcodeInputSelectors) {
              postcodeInput = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' }).catch(() => null);
              if (postcodeInput) {
                console.log(`✅ ${this._tag} Posta kodu input bulundu: ${sel}`);
                break;
              }
            }
            
            if (postcodeInput) {
              // Input'u temizle ve posta kodunu yaz
              await postcodeInput.click({ timeout: 5000 }).catch(() => {});
              await postcodeInput.fill('');
              await this.safeWait(page, 200);
              await postcodeInput.type(postcode, { delay: 50 });
              console.log(`✅ ${this._tag} Posta kodu girildi: ${postcode}`);
              await this.safeWait(page, 500);
              
              // Apply butonuna tıkla
              const applySelectors = [
                'span#GLUXZipUpdate input.a-button-input',
                '#GLUXZipUpdate input[type="submit"]',
                '#GLUXZipUpdate .a-button-input',
                'input[aria-labelledby="GLUXZipUpdate-announce"]'
              ];
              let applyBtn = null;
              for (const sel of applySelectors) {
                applyBtn = await page.$(sel).catch(() => null);
                if (applyBtn) {
                  console.log(`✅ ${this._tag} Apply butonu bulundu: ${sel}`);
                  break;
                }
              }
              
              if (applyBtn) {
                await applyBtn.click({ timeout: 10000 });
                console.log(`✅ ${this._tag} Apply butonuna tıklandı`);
                await this.safeWait(page, 3000);
                
                // Sayfa yenilenmesini bekle
                try {
                  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
                } catch (e) {}
                await this.safeWait(page, 1000);
                
                // Popover kapandı mı kontrol et, kapanmadıysa Done/Close butonuna tıkla
                try {
                  const doneOrCloseBtn = await page.$('button[name="glowDoneButton"], .a-popover-footer button, #a-popover-3 button.a-button-close, button.a-modal-close').catch(() => null);
                  if (doneOrCloseBtn) {
                    const isVisible = await doneOrCloseBtn.isVisible().catch(() => false);
                    if (isVisible) {
                      await doneOrCloseBtn.click({ timeout: 5000 }).catch(() => {});
                      console.log(`✅ ${this._tag} Done/Close butonuna tıklandı (posta kodu sonrası)`);
                      await this.safeWait(page, 2000);
                    }
                  }
                } catch (e) {}
                
                postcodeSetSuccessfully = true;
                console.log(`✅ ${this._tag} Posta kodu ile adres ayarlandı: ${postcode}`);
              } else {
                console.warn(`⚠️ ${this._tag} Apply butonu bulunamadı`);
              }
            } else {
              console.warn(`⚠️ ${this._tag} Posta kodu input alanı bulunamadı, ülke dropdown'u denenecek`);
            }
          } catch (postcodeError) {
            console.warn(`⚠️ ${this._tag} Posta kodu ayarlama hatası: ${postcodeError.message}`);
          }
        }
      }
      
      if (!postcodeSetSuccessfully) {
      // Ülke dropdown'unu bul ve aç
      console.log(`🎭 ${this._tag} Ülke dropdown'u aranıyor: ${targetCountryCode}...`);
      const dropdownSelectors = [
        '#GLUXCountryListDropdown',
        'span#GLUXCountryListDropdown',
        'span.a-button-text[data-action="a-dropdown-button"]',
        '#GLUXCountryList'
      ];
      
      let countryDropdown = null;
      for (const selector of dropdownSelectors) {
        try {
          countryDropdown = await page.waitForSelector(selector, { timeout: 5000, state: 'visible' }); // 15s -> 5s
          if (countryDropdown) {
            console.log(`✅ ${this._tag} Ülke dropdown bulundu: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!countryDropdown) {
        throw new Error('Country dropdown not found');
      }
      
      // Dropdown'u aç (tıkla) - timeout kısaltıldı
      try {
        await countryDropdown.click({ timeout: 10000 }); // 30s -> 10s
        await this.safeWait(page, 1000); // 2s -> 1s
        console.log(`✅ ${this._tag} Dropdown açıldı`);
      } catch (clickError) {
        console.warn(`⚠️ ${this._tag} Dropdown click başarısız, force click deneniyor: ${clickError.message}`);
        await countryDropdown.click({ force: true, timeout: 10000 }); // 30s -> 10s
        await this.safeWait(page, 1000); // 2s -> 1s
      }
      
      // KRİTİK: Dropdown açıldıktan sonra ülkenin baş harfine basarak filtreleme yap
      // amazon.de, amazon.fr vb. sitelerde ülke adları farklı dilde — locale-aware ilk harf kullan
      let firstLetter = null;
      const localeFirstLetter = {
        'amazon.de': { GB: 'V', US: 'V', DE: 'D', FR: 'F', ES: 'S', IT: 'I', JP: 'J', NL: 'N' },
        'amazon.fr': { GB: 'R', US: 'E', DE: 'A', FR: 'F', ES: 'E', IT: 'I', JP: 'J', NL: 'P' },
        'amazon.es': { GB: 'R', US: 'E', DE: 'A', FR: 'F', ES: 'E', IT: 'I', JP: 'J', NL: 'P' },
        'amazon.it': { GB: 'R', US: 'S', DE: 'G', FR: 'F', ES: 'S', IT: 'I', JP: 'G', NL: 'P' },
        'amazon.co.jp': { GB: 'イ', US: 'ア', DE: 'ド', FR: 'フ', ES: 'ス', IT: 'イ', JP: '日', NL: 'オ' }
      };
      const mpMap = localeFirstLetter[sourceMarketplace];
      if (mpMap && mpMap[amazonCountryCode]) {
        firstLetter = mpMap[amazonCountryCode];
        console.log(`🌍 ${this._tag} Locale-aware baş harf: "${firstLetter}" (${sourceMarketplace}, ${amazonCountryCode})`);
      } else if (targetCountryName) {
        firstLetter = targetCountryName.charAt(0).toUpperCase();
        console.log(`🌍 ${this._tag} TargetCountryName'den baş harf: "${firstLetter}" (${targetCountryName})`);
      }
      
      // Dropdown açıldıktan sonra ülkenin baş harfine bas
      if (firstLetter) {
        try {
          // KRİTİK: Popover içindeki liste görünür olana kadar bekle - timeout kısaltıldı
          await page.waitForSelector('#a-popover-4 ul.a-list-item, ul.a-list-item', { timeout: 3000, state: 'visible' }).catch(() => { // 5s -> 3s
            console.warn(`⚠️ ${this._tag} Liste hemen görünür olmadı, devam ediliyor...`);
          });
          await this.safeWait(page, 300); // 500ms -> 300ms
          
          // KRİTİK: Popover içine focus yap (klavye input'unun çalışması için)
          try {
            const popover = await page.$('#a-popover-4');
            if (popover) {
              await popover.focus();
              await this.safeWait(page, 200); // 300ms -> 200ms
            }
          } catch (focusError) {
            console.warn(`⚠️ ${this._tag} Popover focus başarısız: ${focusError.message}`);
          }
          
          // Ülkenin baş harfine bas
          await page.keyboard.press(firstLetter);
          await this.safeWait(page, 800); // 1500ms -> 800ms (filtreleme için daha kısa bekle)
          console.log(`⌨️ ${this._tag} Dropdown açıldı, "${firstLetter}" harfine basıldı, ülke filtreleniyor...`);
        } catch (keyboardError) {
          console.warn(`⚠️ ${this._tag} Keyboard press hatası: ${keyboardError.message}, devam ediliyor...`);
        }
      } else {
        console.warn(`⚠️ ${this._tag} Baş harf bulunamadı, filtreleme yapılmadan devam ediliyor...`);
      }
      
      // Ülke seçeneğini bul ve tıkla
      console.log(`🎭 ${this._tag} Ülke seçeneği aranıyor: ${amazonCountryCode} (${targetCountryName})...`);
      
      // KRİTİK: Popover içindeki seçenekleri al (#a-popover-4 içinde)
      // Önce popover içindeki liste görünür olana kadar bekle
      try {
        await page.waitForSelector('#a-popover-4 ul.a-list-item a[data-value], ul.a-list-item a[data-value]', { timeout: 5000, state: 'visible' });
        console.log(`✅ ${this._tag} Popover içindeki liste görünür`);
      } catch (listError) {
        console.warn(`⚠️ ${this._tag} Liste hemen görünür olmadı, devam ediliyor...`);
      }
      
      const allOptions = await page.$$eval('#a-popover-4 a[data-value], ul.a-list-item a[data-value], a[data-value]', (options) => {
        return options.map(opt => ({
          text: opt.textContent.trim(),
          value: opt.getAttribute('data-value'),
          id: opt.id,
          href: opt.getAttribute('href') || '',
          visible: opt.offsetParent !== null // Element görünür mü?
        })).filter(opt => opt.visible); // Sadece görünür seçenekleri al
      });
      console.log(`🔍 ${this._tag} Mevcut ülke seçenekleri: ${allOptions.length} adet`);
      
      // Ülke seçeneğini bul - data-value içinde country code'u ara
      let foundOption = null;
      for (const opt of allOptions) {
        try {
          const valueObj = JSON.parse(opt.value);
          if (valueObj.stringVal === amazonCountryCode || opt.text.includes(targetCountryName)) {
            foundOption = opt;
            console.log(`✅ ${this._tag} Ülke seçeneği bulundu: ${opt.text} (${opt.value})`);
            break;
          }
        } catch (e) {
          // JSON parse başarısız, string içinde ara
          if (opt.value && (opt.value.includes(amazonCountryCode) || opt.text.includes(targetCountryName))) {
            foundOption = opt;
            console.log(`✅ ${this._tag} Ülke seçeneği bulundu (string match): ${opt.text}`);
            break;
          }
        }
      }
      
      if (!foundOption) {
        const sampleOptions = allOptions.slice(0, 5).map(opt => opt.text);
        throw new Error(`Country option not found for ${amazonCountryCode} (${targetCountryName}). Toplam ${allOptions.length} seçenek var (örnek: ${sampleOptions.join(', ')})`);
      }
      
      // KRİTİK: Filtreleme yapıldıktan sonra ID'ler değişebilir, bu yüzden sadece data-value ile exact match kullan
      // Ülke seçeneğini bul ve tıkla - öncelikli: data-value exact match (ID'ler filtreleme sonrası yanlış olabilir)
      const countryOptionSelectors = [];
      
      // KRİTİK: Önce popover içinde data-value ile exact match (#a-popover-4 içinde)
      countryOptionSelectors.push(`#a-popover-4 a[data-value="${foundOption.value}"]`);
      countryOptionSelectors.push(`ul.a-list-item a[data-value="${foundOption.value}"]`);
      
      // Fallback: Genel data-value match
      countryOptionSelectors.push(`a[data-value="${foundOption.value}"]`);
      
      // Fallback: text match (ama ID kullanma - filtreleme sonrası yanlış olabilir)
      countryOptionSelectors.push(`#a-popover-4 a:has-text("${foundOption.text}")`);
      countryOptionSelectors.push(`ul.a-list-item a:has-text("${foundOption.text}")`);
      countryOptionSelectors.push(`a:has-text("${foundOption.text}")`);
      
      // KRİTİK: ID'leri en sona koy (filtreleme sonrası yanlış olabilir)
      if (foundOption.id) {
        countryOptionSelectors.push(`#a-popover-4 a#${foundOption.id}`);
        countryOptionSelectors.push(`ul.a-list-item a#${foundOption.id}`);
        countryOptionSelectors.push(`a#${foundOption.id}`);
        console.log(`🔍 ${this._tag} Bulunan ID fallback olarak eklendi: a#${foundOption.id} (filtreleme sonrası yanlış olabilir)`);
      }
      
      let countryOption = null;
      for (const selector of countryOptionSelectors) {
        try {
          // KRİTİK: Sadece görünür elementleri bekle
          countryOption = await page.waitForSelector(selector, { timeout: 8000, state: 'visible' });
          if (countryOption) {
            // KRİTİK: Seçilecek elementin text'ini ve data-value'sunu kontrol et - yanlış ülke seçilmesini önle
            const optionText = await countryOption.textContent().catch(() => '');
            const optionDataValue = await countryOption.getAttribute('data-value').catch(() => '');
            
            // Data-value içinde doğru country code olup olmadığını kontrol et
            let isValidOption = false;
            try {
              if (optionDataValue) {
                const valueObj = JSON.parse(optionDataValue);
                isValidOption = valueObj.stringVal === amazonCountryCode;
              }
            } catch (e) {
              // JSON parse başarısız, string içinde ara
              isValidOption = optionDataValue && optionDataValue.includes(`"stringVal":"${amazonCountryCode}"`);
            }
            
            // Text içinde de kontrol et (fallback)
            if (!isValidOption && optionText) {
              isValidOption = optionText.includes(targetCountryName) || optionText.toLowerCase().includes(amazonCountryCode.toLowerCase());
            }
            
            if (!isValidOption) {
              console.warn(`⚠️ ${this._tag} Seçilen element yanlış ülkeye ait: "${optionText}" (data-value: ${optionDataValue}), atlanıyor...`);
              countryOption = null;
              continue;
            }
            
            console.log(`✅ ${this._tag} Ülke seçeneği elementi bulundu ve doğrulandı: ${selector} - "${optionText}"`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!countryOption) {
        throw new Error(`Country option element not found for ${foundOption.text}`);
      }
      
      // Ülke seçeneğine tıkla
      try {
        await countryOption.scrollIntoViewIfNeeded();
        await this.safeWait(page, 500);
        await countryOption.click({ timeout: 30000 });
        await this.safeWait(page, 2000);
        console.log(`✅ ${this._tag} Ülke seçildi: ${amazonCountryCode} (${targetCountryName})`);
      } catch (clickError) {
        console.warn(`⚠️ ${this._tag} Ülke seçimi click başarısız, force click deneniyor: ${clickError.message}`);
        await countryOption.click({ force: true, timeout: 30000 });
        await this.safeWait(page, 2000);
      }
      
      // Done butonuna tıkla
      console.log(`🎭 ${this._tag} "Done" butonu aranıyor...`);
      // KRİTİK: name="glowDoneButton" sabit; #a-autoid-* dinamik ID'ler değişebilir — önce sabit selector
      const doneButtonSelectors = [
        'button[name="glowDoneButton"]',
        'button.a-button-text[name="glowDoneButton"]',
        'span.a-button-inner button[name="glowDoneButton"]',
        'input[name="glowDoneButton"]',
        'button[data-action="glowDoneButton"]',
        '[name="glowDoneButton"]'
      ];
      
      let doneButton = null;
      for (const selector of doneButtonSelectors) {
        try {
          doneButton = await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });
          if (doneButton) {
            console.log(`✅ ${this._tag} "Done" butonu bulundu: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!doneButton) {
        throw new Error('Done button not found');
      }
      
      // Done butonuna tıkla
      try {
        await doneButton.scrollIntoViewIfNeeded();
        await this.safeWait(page, 500);
        await doneButton.click({ timeout: 30000 });
        await this.safeWait(page, 2000); // Sayfa yeniden yüklenmesi için bekle
        console.log(`✅ ${this._tag} "Done" butonuna tıklandı, ülke seçimi tamamlandı`);
      } catch (clickError) {
        console.log(`⚠️ ${this._tag} Normal click başarısız, JS click deneniyor: ${clickError.message}`);
        await page.evaluate(() => {
          const btn = document.querySelector('button[name="glowDoneButton"]') || 
                     document.querySelector('[name="glowDoneButton"]') ||
                     document.querySelector('button[data-action="glowDoneButton"]');
          if (btn) btn.click();
        });
        await this.safeWait(page, 2000);
      }
      
      // KRİTİK: Sayfa yeniden yüklenecek, bunu bekle - timeout kısaltıldı
      console.log(`⏳ ${this._tag} Sayfa yeniden yüklenmesi bekleniyor (Done butonuna tıklandıktan sonra)...`);
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { // 30s -> 10s
          console.warn(`⚠️ ${this._tag} Network idle bekleme timeout, devam ediliyor...`);
        });
        await this.safeWait(page, 1000); // 2s -> 1s
        console.log(`✅ ${this._tag} Sayfa yeniden yüklendi`);
      } catch (loadError) {
        console.warn(`⚠️ ${this._tag} Sayfa yükleme bekleme hatası: ${loadError.message}, devam ediliyor...`);
      }
      } // end if (!postcodeSetSuccessfully) — ülke dropdown bloğu
      
      // KRİTİK: Para birimi seçimi customer-preferences sayfasından yapılmalı (aksi halde yanlış fiyatlar çekilebiliyor)
      try {
        const currentAsinUrl = asinUrl || page.url();
        const preferencesReturnUrl = (() => {
          try {
            const u = new URL(currentAsinUrl);
            return `${u.pathname}${u.search}`;
          } catch (e) {
            // Fallback: tam URL değilse /dp/... kısmını yakala
            const idx = String(currentAsinUrl).indexOf('/dp/');
            return idx >= 0 ? String(currentAsinUrl).slice(idx) : '/';
          }
        })();

        const preferencesUrl = `${baseUrl}/customer-preferences/edit?ref_=icp_cop_flyout_change&preferencesReturnUrl=${encodeURIComponent(preferencesReturnUrl)}`;
        console.log(`💵 ${this._tag} Para birimi sayfasına gidiliyor: ${preferencesUrl}`);

        await page.goto(preferencesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.safeWait(page, 1500);

        // Sayfa ana container'larını bekle
        await page.waitForSelector('#international-customer-select-preferences-form, #icp-currency-settings, #icp-currency-dropdown-container', {
          timeout: 15000,
          state: 'attached'
        }).catch(() => {
          console.warn(`⚠️ ${this._tag} customer-preferences container bekleme timeout, devam ediliyor...`);
        });

        // Mevcut para birimini oku
        const currencyPromptSelectors = [
          '#icp-currency-dropdown-container span.a-dropdown-prompt',
          'span#icp-currency-dropdown-selected-item-prompt span.a-dropdown-prompt',
          'span#icp-currency-dropdown-selected-item-prompt'
        ];
        let currentCurrencyPromptText = '';
        for (const selector of currencyPromptSelectors) {
          try {
            const el = await page.$(selector);
            if (el) {
              const txt = await el.textContent().then(t => t.trim()).catch(() => '');
              if (txt) {
                currentCurrencyPromptText = txt;
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
        if (currentCurrencyPromptText) {
          console.log(`🔍 ${this._tag} Mevcut para birimi prompt: "${currentCurrencyPromptText}"`);
        }

        const isAlreadyCorrect = currentCurrencyPromptText
          ? currentCurrencyPromptText.toUpperCase().includes(`- ${targetCurrency.toUpperCase()} -`) ||
            currentCurrencyPromptText.toUpperCase().includes(` ${targetCurrency.toUpperCase()} `) ||
            currentCurrencyPromptText.toUpperCase().includes(targetCurrency.toUpperCase())
          : false;

        if (!isAlreadyCorrect) {
          // KRİTİK: Önce radio button ile para birimi seçmeyi dene (amazon.co.uk vb. siteler radio button kullanıyor)
          let currencySetViaRadio = false;
          try {
            const radioLabels = await page.$$('#icp-popular-currencies-section label, #icp-currency-settings label, #icp-popular-currencies-section div.a-radio label');
            console.log(`🔍 ${this._tag} Radio button ile para birimi aranıyor: ${radioLabels.length} label bulundu`);
            for (const label of radioLabels) {
              const text = await label.textContent().catch(() => '');
              console.log(`🔍 ${this._tag} Radio label: "${text.trim().substring(0, 60)}"`);
              if (text.toUpperCase().includes(targetCurrency.toUpperCase())) {
                await label.scrollIntoViewIfNeeded().catch(() => {});
                await this.safeWait(page, 300);
                await label.click({ timeout: 10000 });
                currencySetViaRadio = true;
                console.log(`✅ ${this._tag} Radio button ile para birimi seçildi: ${text.trim()}`);
                await this.safeWait(page, 1000);
                break;
              }
            }
          } catch (radioError) {
            console.warn(`⚠️ ${this._tag} Radio button para birimi hatası: ${radioError.message}`);
          }
          
          if (!currencySetViaRadio) {
          // Dropdown'u aç (radio button bulunamadıysa)
          console.log(`💵 ${this._tag} Para birimi dropdown açılıyor...`);
          const dropdownOpenSelectors = [
            '#icp-currency-dropdown-selected-item-prompt',
            '#icp-currency-dropdown-container span.a-dropdown-prompt',
            '#icp-currency-dropdown-container'
          ];
          let dropdownOpener = null;
          for (const selector of dropdownOpenSelectors) {
            try {
              dropdownOpener = await page.waitForSelector(selector, { timeout: 10000, state: 'visible' });
              if (dropdownOpener) {
                break;
              }
            } catch (e) {
              continue;
            }
          }
          if (!dropdownOpener) {
            console.warn(`⚠️ ${this._tag} Currency dropdown opener bulunamadı, devam ediliyor...`);
          }

          if (dropdownOpener) {
            await dropdownOpener.scrollIntoViewIfNeeded().catch(() => {});
            await this.safeWait(page, 300);
            await dropdownOpener.click({ timeout: 30000 }).catch(async (e) => {
              console.warn(`⚠️ ${this._tag} Currency dropdown normal click başarısız, force click deneniyor: ${e.message}`);
              await dropdownOpener.click({ force: true, timeout: 30000 });
            });
            await this.safeWait(page, 1000);

            // Popover içinden para birimini seç
            console.log(`💵 ${this._tag} Para birimi seçeneği aranıyor: ${targetCurrency}...`);
            const optionSelectors = [
              `div.a-popover-wrapper li#${targetCurrency} a`,
              `div.a-popover-wrapper li#${targetCurrency} span`,
              `#a-popover-1 li#${targetCurrency} a`,
              `#a-popover-1 li#${targetCurrency} span`,
              `div.a-popover-wrapper a:has-text("${targetCurrency}")`,
              `#a-popover-1 a:has-text("${targetCurrency}")`
            ];
            let optionEl = null;
            for (const selector of optionSelectors) {
              try {
                optionEl = await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });
                if (optionEl) {
                  console.log(`✅ ${this._tag} Para birimi seçeneği bulundu: ${selector}`);
                  break;
                }
              } catch (e) {
                continue;
              }
            }
            if (optionEl) {
              await optionEl.scrollIntoViewIfNeeded().catch(() => {});
              await this.safeWait(page, 300);
              await optionEl.click({ timeout: 30000 }).catch(async (e) => {
                console.warn(`⚠️ ${this._tag} Currency option normal click başarısız, force click deneniyor: ${e.message}`);
                await optionEl.click({ force: true, timeout: 30000 });
              });
              await this.safeWait(page, 1200);
              console.log(`✅ ${this._tag} Para birimi dropdown'dan seçildi: ${targetCurrency}`);
            } else {
              console.warn(`⚠️ ${this._tag} Para birimi seçeneği bulunamadı: ${targetCurrency}`);
            }
          } // end if (dropdownOpener)
          } // end if (!currencySetViaRadio)
        } else {
          console.log(`✅ ${this._tag} Para birimi zaten doğru: ${targetCurrency}`);
        }

        // Save butonuna tıkla (değişiklik olmasa bile, Amazon bazen state'i apply ediyor)
        console.log(`💾 ${this._tag} Save butonu aranıyor...`);
        const saveSelectors = [
          'span#icp-save-button input.a-button-input[type="submit"]',
          'span#icp-save-button input.a-button-input',
          'span#icp-save-button input',
          'input.a-button-input[type="submit"][aria-labelledby="icp-save-button-announce"]'
        ];
        let saveButton = null;
        for (const selector of saveSelectors) {
          try {
            saveButton = await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });
            if (saveButton) {
              console.log(`✅ ${this._tag} Save butonu bulundu: ${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
        if (!saveButton) {
          throw new Error('Save butonu bulunamadı');
        }

        await saveButton.scrollIntoViewIfNeeded().catch(() => {});
        await this.safeWait(page, 300);
        await saveButton.click({ timeout: 30000 }).catch(async (e) => {
          console.warn(`⚠️ ${this._tag} Save normal click başarısız, force click deneniyor: ${e.message}`);
          await saveButton.click({ force: true, timeout: 30000 });
        });

        // Save sonrası returnUrl'e yönlenmesini bekle
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await this.safeWait(page, 1500);

        // Eğer hala preferences sayfasındaysak, ASIN sayfasına dön
        const afterUrl = page.url();
        if (afterUrl.includes('/customer-preferences/') && asinUrl) {
          console.log(`🔗 ${this._tag} Save sonrası ASIN sayfasına geri dönülüyor: ${asinUrl}`);
          await page.goto(asinUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.safeWait(page, 2000);
        }
      } catch (currencyError) {
        console.warn(`⚠️ ${this._tag} Para birimi seçimi hatası: ${currencyError.message}`);
        // Hata olsa bile akışı durdurma; mümkünse ASIN sayfasına geri dön
        try {
          const urlNow = page.url();
          if (urlNow.includes('/customer-preferences/') && asinUrl) {
            console.log(`🔗 ${this._tag} Para birimi hatası sonrası ASIN sayfasına geri dönülüyor: ${asinUrl}`);
            await page.goto(asinUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.safeWait(page, 2000);
          }
        } catch (navError) {
          console.warn(`⚠️ ${this._tag} Para birimi hatası sonrası navigation hatası: ${navError.message}`);
        }
      }
      
      return { success: true, error: null };
    } catch (error) {
      console.error(`❌ ${this._tag} Ülke ve para birimi seçimi hatası: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract buybox data from PDP (Product Detail Page)
   * @param {Object} page - Playwright page object
   * @returns {Promise<Object | null>}
   */
  async extractBuyboxData(page, asin = '') {
    if (asin) this._currentAsin = asin;
    try {
      console.log(`🔍 ${this._tag} Buybox bilgileri çekiliyor (PDP sayfasından)...`);
      
      // KRİTİK: Sayfa title'ını kontrol et - eğer sadece "Amazon.com" ise sayfa tam yüklenmemiş olabilir
      const pageTitle = await page.title().catch(() => '');
      if (pageTitle === 'Amazon.com' || pageTitle === 'Amazon' || !pageTitle) {
        console.warn(`⚠️ ${this._tag} Sayfa title sadece "Amazon.com" - sayfa tam yüklenmemiş olabilir, ekstra bekleme...`);
        await this.safeWait(page, 5000);
        
        // Buybox container'ının yüklenmesini bekle
        try {
          await page.waitForSelector('#desktop_buybox, #buybox, #qualifiedBuybox, #apex_offerDisplay_single_desktop, #apex_offerDisplay_desktop', { 
            timeout: 20000, 
            state: 'attached' 
          });
          console.log(`✅ ${this._tag} Buybox container yüklendi`);
        } catch (e) {
          console.warn(`⚠️ ${this._tag} Buybox container bekleme timeout`);
        }
      }
      
      // Sayfanın yüklenmesini bekle
      await this.safeWait(page, 3000);
      
      // ADIM 1: Shipper/Seller bilgisi
      let sellerName = null;
      let soldBy = null;
      let shipsFrom = null;
      try {
        // KRİTİK: Amazon'un farklı buybox yapılarını destekle
        // "Shipper / Seller" label'ından sonraki text'i al
        const merchantInfoSelectors = [
          // Standart merchantInfo yapısı
          'div#merchantInfoFeature_feature_div div.offer-display-feature-text-message',
          'div#merchantInfoFeature_feature_div span.offer-display-feature-text-message',
          'div#merchantInfoFeature_feature_div .offer-display-feature-text-message',
          'div#merchantInfoFeature_feature_div span.a-size-small.offer-display-feature-text-message',
          // Alternatif selector'lar - farklı Amazon sayfa yapıları için
          '#merchant-info',
          '#sellerProfileTriggerId',
          '#tabular-buybox-truncate-0 .tabular-buybox-text a',
          '#tabular-buybox-truncate-1 .tabular-buybox-text a',
          'div[data-feature-name="merchantInfo"] .offer-display-feature-text-message',
          // Buybox içinde satıcı linki
          '#buybox a[href*="/sp?seller="]',
          '#desktop_buybox a[href*="/sp?seller="]',
          '#qualifiedBuybox a[href*="/sp?seller="]',
          // Sold by text
          '#buybox-see-all-buying-choices-announce',
          'span:has-text("Sold by") + span',
          'span:has-text("Ships from") + span'
        ];
        
        for (const selector of merchantInfoSelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              const text = await element.textContent().then(t => t.trim()).catch(() => null);
              if (text) {
                // "Sold by X" formatından sadece X'i çıkar
                const soldByMatch = text.match(/Sold by\s+(.+?)(?:\s+Seller rating|\s+\(|\s*$)/i);
                if (soldByMatch) {
                  sellerName = soldByMatch[1].trim();
                  soldBy = sellerName;
                } else {
                  // Direkt satıcı adı olabilir
                  sellerName = text;
                  soldBy = sellerName;
                }
                
                // Seller ID'yi link'ten çek (eğer element bir link ise)
                if (element && (await element.evaluate(el => el.tagName.toLowerCase()) === 'a')) {
                  const href = await element.getAttribute('href').catch(() => '');
                  if (href) {
                    const sellerIdMatch = href.match(/seller=([A-Z0-9]+)/i);
                    if (sellerIdMatch) {
                      // sellerId field'ı yoksa eklenebilir
                    }
                  }
                }
                
                if (sellerName) {
                  console.log(`✅ ${this._tag} Buybox sellerName çekildi: ${sellerName}`);
                  break;
                }
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        // KRİTİK: "Shipper / Seller" label kontrolü - Eğer bu label varsa, seller bilgisini çek
        if (!sellerName) {
          try {
            // "Shipper / Seller" label'ını kontrol et
            const shipperSellerLabel = await page.$('div#merchantInfoFeature_feature_div span.a-size-small.a-color-tertiary:has-text("Shipper / Seller")');
            if (shipperSellerLabel) {
              console.log(`✅ ${this._tag} "Shipper / Seller" label bulundu`);
              
              // "Shipper / Seller" label'ından sonraki text'i al
              const shipperSellerText = await page.$eval('div#merchantInfoFeature_feature_div', (div) => {
                const label = div.querySelector('span.a-size-small.a-color-tertiary');
                if (label && label.textContent.includes('Shipper / Seller')) {
                  const textElement = div.querySelector('div.offer-display-feature-text-message, span.offer-display-feature-text-message, a#sellerProfileTriggerId');
                  return textElement ? textElement.textContent.trim() : null;
                }
                return null;
              }).catch(() => null);
              
              if (shipperSellerText) {
                sellerName = shipperSellerText;
                soldBy = shipperSellerText;
                console.log(`✅ ${this._tag} "Shipper / Seller" text'inden sellerName çekildi: ${sellerName}`);
              }
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} "Shipper / Seller" kontrolü hatası: ${e.message}`);
          }
        }
        
        // KRİTİK: Eğer hala bulunamadıysa, buybox container'ından text parse et
        if (!sellerName) {
          try {
            // Buybox container text'inden "Ships from" ve "Sold by" bilgilerini çek
            const buyboxSelectors = [
              '#desktop_buybox',
              '#buybox',
              '#qualifiedBuybox',
              '#tabular-buybox'
            ];
            
            for (const selector of buyboxSelectors) {
              try {
                const buyboxText = await page.textContent(selector).catch(() => '');
                if (buyboxText) {
                  // "Sold by" pattern'i
                  const soldByMatch = buyboxText.match(/Sold by\s+([^\n\r]+?)(?:\s+Ships from|$)/i);
                  if (soldByMatch) {
                    sellerName = soldByMatch[1].trim();
                    soldBy = sellerName;
                    console.log(`✅ ${this._tag} Buybox sellerName buybox text'inden çekildi: ${sellerName}`);
                    break;
                  }
                  
                  // "Ships from" ve "Sold by" ayrı ayrı
                  const shipsFromMatch = buyboxText.match(/Ships from\s+([^\n\r]+?)(?:\s+Sold by|$)/i);
                  if (shipsFromMatch && !shipsFrom) {
                    shipsFrom = shipsFromMatch[1].trim();
                  }
                }
              } catch (e) {
                continue;
              }
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} Buybox text parse hatası: ${e.message}`);
          }
        }
        
        // "Ships From" bilgisi (eğer varsa)
        if (!shipsFrom) {
          try {
            const shipsFromText = await page.textContent('div#merchantInfoFeature_feature_div').catch(() => '');
            const shipsFromMatch = shipsFromText.match(/Ships from\s+([^\n\r]+)/i);
            if (shipsFromMatch) {
              shipsFrom = shipsFromMatch[1].trim();
              console.log(`✅ ${this._tag} Buybox shipsFrom çekildi: ${shipsFrom}`);
            }
          } catch (e) {
            // Ships from bulunamadı
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Buybox sellerName çekilemedi: ${e.message}`);
      }
      
      // ADIM 2: Ürün durumu (Condition) - "Buy new:" veya "Buy used:"
      let condition = 'New';
      let isNew = true;
      let isUsed = false;
      try {
        const conditionSelectors = [
          'div#newAccordionCaption_feature_div span.a-text-bold',
          'div#newAccordionCaption_feature_div .a-text-bold',
          'h5 div#newAccordionCaption_feature_div span.a-text-bold'
        ];
        
        for (const selector of conditionSelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              const conditionText = await element.textContent().then(t => t.trim()).catch(() => null);
              if (conditionText) {
                const conditionLower = conditionText.toLowerCase();
                if (conditionLower.includes('buy new') || conditionLower.includes('new')) {
                  condition = 'New';
                  isNew = true;
                  isUsed = false;
                } else if (conditionLower.includes('buy used') || conditionLower.includes('used')) {
                  condition = 'Used';
                  isNew = false;
                  isUsed = true;
                }
                console.log(`✅ ${this._tag} Buybox condition çekildi: ${condition} (${conditionText})`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Buybox condition çekilemedi: ${e.message}`);
      }
      
      // ADIM 3: Fiyat ve Shipping & Import Charges
      let price = null;
      let priceText = null;
      let shippingPrice = null;
      let shippingText = null;
      try {
        // Fiyat: div#corePrice_feature_div içindeki price
        const priceSelectors = [
          'div#corePrice_feature_div span.a-price span[aria-hidden="true"]',
          'div#corePrice_feature_div span.a-price .a-offscreen',
          'div#corePrice_feature_div .a-price span[aria-hidden="true"]',
          'div#corePrice_feature_div .a-spacing-top-mini',
          // KRİTİK: Alternatif fiyat selector'ları
          '#qualifiedBuybox span.a-price .a-offscreen',
          '#qualifiedBuybox span.a-price span[aria-hidden="true"]',
          '#desktop_buybox span.a-price .a-offscreen',
          '#desktop_buybox span.a-price span[aria-hidden="true"]',
          '#buybox span.a-price .a-offscreen',
          'span.a-price.a-text-price span.a-offscreen',
          '#apex_offerDisplay_desktop span.a-price .a-offscreen'
        ];
        
        for (const selector of priceSelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              priceText = await element.textContent().then(t => t.trim()).catch(() => null);
              if (priceText) {
                // Fiyatı parse et - "$199 . 99" -> 199.99 (boşlukları temizle)
                const cleanedPriceText = priceText.replace(/\s+/g, '');
                const priceMatch = cleanedPriceText.match(/[\$£€]?([\d,]+\.?\d*)/);
                if (priceMatch) {
                  price = parseFloat(priceMatch[1].replace(/,/g, ''));
                  console.log(`✅ ${this._tag} Buybox price çekildi: ${priceText} -> ${price}`);
                  break;
                }
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        // KRİTİK: Eğer hala fiyat bulunamadıysa, buybox içeriğinden parse et
        if (!price) {
          try {
            const buyboxInnerSelectors = [
              '#qualifiedBuybox .a-box-inner',
              '#desktop_buybox .a-box-inner',
              '#buybox .a-box-inner'
            ];
            
            for (const selector of buyboxInnerSelectors) {
              try {
                const buyboxInner = await page.textContent(selector).catch(() => '');
                if (buyboxInner) {
                  // "$24.99" veya "$24 . 99" formatından fiyat çıkar
                  const priceMatch = buyboxInner.match(/\$\s*([\d,]+(?:\s*\.\s*\d{2})?)/);
                  if (priceMatch) {
                    const cleanedPrice = priceMatch[1].replace(/\s+/g, '');
                    price = parseFloat(cleanedPrice.replace(/,/g, ''));
                    priceText = `$${cleanedPrice}`;
                    console.log(`✅ ${this._tag} Buybox price a-box-inner'dan çekildi: ${priceText} -> ${price}`);
                    
                    // Aynı içerikten shipping bilgisini de çek
                    // "$9.42 Shipping to United Kingdom" veya "$9.42 delivery"
                    const shippingMatch = buyboxInner.match(/\$\s*([\d,]+\.?\d*)\s*(?:Shipping|delivery)/i);
                    if (shippingMatch && !shippingPrice) {
                      shippingPrice = parseFloat(shippingMatch[1].replace(/,/g, ''));
                      shippingText = shippingMatch[0];
                      console.log(`✅ ${this._tag} Buybox shippingPrice a-box-inner'dan çekildi: ${shippingPrice}`);
                    }
                    break;
                  }
                }
              } catch (e) {
                continue;
              }
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} Buybox a-box-inner parse hatası: ${e.message}`);
          }
        }
        
        // Shipping & Import Charges: div#amazonGlobal_feature_div
        // KRİTİK: Shipping bilgilerinin render olması için ekstra bekleme
        await this.safeWait(page, 3000);
        
        if (!shippingPrice) {
          console.log(`🔍 ${this._tag} Shipping price text aranıyor...`);
          const shippingPriceSelectors = [
            '#amazonGlobal_feature_div span.a-size-base.a-color-secondary',
            '#apex_offerDisplay_single_desktop #amazonGlobal_feature_div span.a-size-base.a-color-secondary',
            '#desktop_qualifiedBuyBox #amazonGlobal_feature_div span.a-size-base.a-color-secondary',
            '#desktop_qualifiedBuyBox span.a-size-base.a-color-secondary',
            '#apex_offerDisplay_single_desktop span.a-size-base.a-color-secondary',
            '#qualifiedBuybox span.a-size-base.a-color-secondary',
            '#buybox span.a-size-base.a-color-secondary',
            '#desktop_buybox span.a-size-base.a-color-secondary',
            'span.a-size-base.a-color-secondary:has-text("Shipping")',
            'span.a-size-base.a-color-secondary:has-text("Import Charges")',
            'span.a-size-base.a-color-secondary:has-text("Shipping & Import")',
            '#desktop_buybox span:has-text("Shipping")',
            '#buybox span:has-text("Shipping")',
            '#qualifiedBuybox span:has-text("Shipping")'
          ];
          
          for (const selector of shippingPriceSelectors) {
            try {
              const element = await page.$(selector);
              if (element) {
                const isVisible = await element.isVisible().catch(() => false);
                if (isVisible) {
                  shippingText = await element.textContent().then(t => t.trim()).catch(() => null);
                  if (shippingText && (shippingText.includes('Shipping') || shippingText.includes('Import Charges') || shippingText.includes('delivery'))) {
                    console.log(`✅ ${this._tag} Shipping price text bulundu: ${shippingText} (selector: ${selector})`);
                    break;
                  }
                }
              }
            } catch (e) {
              continue;
            }
          }
          
          // Eğer hala bulunamadıysa, buybox içinde text arama
          if (!shippingText) {
            console.log(`🔍 ${this._tag} Shipping text selector'larla bulunamadı, buybox içinde aranıyor...`);
            try {
              const buyboxSelectors = ['#desktop_buybox', '#buybox', '#qualifiedBuybox', '#apex_offerDisplay_single_desktop'];
              for (const buyboxSelector of buyboxSelectors) {
                try {
                  const buyboxElement = await page.$(buyboxSelector);
                  if (buyboxElement) {
                    const buyboxText = await buyboxElement.textContent();
                    if (buyboxText) {
                      // Shipping ile ilgili text'i bul
                      const shippingMatch = buyboxText.match(/([^.]*(?:Shipping|Import Charges|delivery)[^.]*)/i);
                      if (shippingMatch) {
                        shippingText = shippingMatch[1].trim();
                        console.log(`✅ ${this._tag} Shipping price text bulundu (buybox text): ${shippingText}`);
                        break;
                      }
                    }
                  }
                } catch (e) {
                  continue;
                }
              }
            } catch (e) {
              console.warn(`⚠️ ${this._tag} Buybox text arama hatası: ${e.message}`);
            }
          }
          
          // Shipping price parse et
          if (shippingText) {
            console.log(`🔍 ${this._tag} Shipping price text parse ediliyor: "${shippingText}"`);
            
            // "No Import Charges & $7.65 Shipping to United Kingdom" formatından fiyatı çıkar
            let priceMatch = shippingText.match(/&\s*[\$£€]?\s*([\d,]+\.?\d*)\s*(?:Shipping|Import|to)/i);
            if (priceMatch) {
              shippingPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
              console.log(`✅ ${this._tag} Standart gönderim fiyatı bulundu (after &): ${shippingPrice}`);
            } else {
              // "$94.14 Shipping & Import Charges" formatından fiyatı çıkar
              priceMatch = shippingText.match(/[\$£€]?\s*([\d,]+\.?\d*)\s*(?:Shipping|Import)/i);
              if (priceMatch) {
                shippingPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
                console.log(`✅ ${this._tag} Standart gönderim fiyatı bulundu (before Shipping): ${shippingPrice}`);
              } else {
                // Alternatif: Herhangi bir fiyat bul (ilk fiyat)
                const altPriceMatch = shippingText.match(/[\$£€]?\s*([\d,]+\.?\d*)/);
                if (altPriceMatch) {
                  shippingPrice = parseFloat(altPriceMatch[1].replace(/,/g, ''));
                  console.log(`✅ ${this._tag} Standart gönderim fiyatı bulundu (first price): ${shippingPrice}`);
                } else {
                  console.warn(`⚠️ ${this._tag} Shipping price text'ten fiyat çıkarılamadı: "${shippingText}"`);
                }
              }
            }
          } else {
            console.warn(`⚠️ ${this._tag} Shipping price text bulunamadı`);
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Buybox price çekilemedi: ${e.message}`);
      }
      
      // ADIM 4: Tarihler (sadece gün ve ay, önündeki price alınmayacak)
      let standardDeliveryDate = null;
      let expressDeliveryDate = null;
      try {
        // Standard delivery: div#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE > span
        // KRİTİK: data-csa-c-delivery-time attribute'undan tarih aralığı çekilebilir (örn: "February 9 - 19")
        console.log(`🔍 ${this._tag} Standart gönderim tarihi aranıyor...`);
        const standardDeliverySelectors = [
          'span[data-csa-c-delivery-time]', // Öncelikli - attribute'dan direkt çek (tarih aralığı dahil)
          '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span[data-csa-c-delivery-time]',
          '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span.a-text-bold',
          '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span span.a-text-bold',
          '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
          '#deliveryBlockMessage span.a-text-bold',
          '#deliveryBlockContainer span.a-text-bold',
          '#deliveryBlockMessage',
          '#deliveryBlockContainer',
          'div#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span.a-text-bold',
          'div#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
          '#deliveryBlock_feature_div span.a-text-bold',
          '#deliveryBlock_feature_div',
          'span.a-text-bold:has-text("Monday"), span.a-text-bold:has-text("Tuesday"), span.a-text-bold:has-text("Wednesday"), span.a-text-bold:has-text("Thursday"), span.a-text-bold:has-text("Friday"), span.a-text-bold:has-text("Saturday"), span.a-text-bold:has-text("Sunday")'
        ];
        
        for (const selector of standardDeliverySelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              // KRİTİK: Önce data-csa-c-delivery-time attribute'undan tarih aralığını çek
              const deliveryTimeAttr = await element.getAttribute('data-csa-c-delivery-time');
              if (deliveryTimeAttr) {
                standardDeliveryDate = deliveryTimeAttr.trim();
                console.log(`✅ ${this._tag} Standart gönderim tarihi bulundu (attribute): ${standardDeliveryDate} (selector: ${selector})`);
                break;
              }
              
              const isVisible = await element.isVisible().catch(() => false);
              const dateText = await element.textContent().then(t => t.trim()).catch(() => null);
              if (dateText) {
                // KRİTİK: Tarih aralığı formatını kontrol et (örn: "February 9 - 19")
                const dateRangeMatch = dateText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2})/i);
                if (dateRangeMatch) {
                  standardDeliveryDate = dateRangeMatch[1].trim();
                  console.log(`✅ ${this._tag} Standart gönderim tarihi bulundu (tarih aralığı): ${standardDeliveryDate} (selector: ${selector})`);
                  break;
                }
                
                // Tarih formatını kontrol et (Monday, Tuesday, vb. içermeli)
                const dateMatch = dateText.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                if (dateMatch) {
                  standardDeliveryDate = dateMatch[1].trim();
                  console.log(`✅ ${this._tag} Standart gönderim tarihi bulundu: ${standardDeliveryDate} (selector: ${selector})`);
                  break;
                } else if (dateText.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i)) {
                  // Sadece gün adı varsa, tam text'i al
                  standardDeliveryDate = dateText;
                  console.log(`✅ ${this._tag} Standart gönderim tarihi bulundu (partial): ${standardDeliveryDate} (selector: ${selector})`);
                  break;
                }
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        // Eğer hala bulunamadıysa, delivery block içinde text arama
        if (!standardDeliveryDate) {
          console.log(`🔍 ${this._tag} Delivery tarihi selector'larla bulunamadı, delivery block içinde aranıyor...`);
          try {
            const deliverySelectors = ['#deliveryBlockMessage', '#deliveryBlockContainer', '#deliveryBlock_feature_div'];
            for (const deliverySelector of deliverySelectors) {
              try {
                const deliveryElement = await page.$(deliverySelector);
                if (deliveryElement) {
                  const deliveryText = await deliveryElement.textContent();
                  if (deliveryText) {
                    // KRİTİK: Tarih aralığı formatını kontrol et (örn: "February 9 - 19")
                    const dateRangeMatch = deliveryText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2})/i);
                    if (dateRangeMatch) {
                      standardDeliveryDate = dateRangeMatch[1].trim();
                      console.log(`✅ ${this._tag} Standart gönderim tarihi bulundu (delivery block text - tarih aralığı): ${standardDeliveryDate}`);
                      break;
                    }
                    
                    const dateMatch = deliveryText.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                    if (dateMatch) {
                      standardDeliveryDate = dateMatch[1].trim();
                      console.log(`✅ ${this._tag} Standart gönderim tarihi bulundu (delivery block text): ${standardDeliveryDate}`);
                      break;
                    }
                  }
                }
              } catch (e) {
                continue;
              }
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} Delivery block text arama hatası: ${e.message}`);
          }
        }
        
        // Express delivery: div#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE > span
        // KRİTİK: "Or fastest delivery February 2 - 4" formatını destekle
        // DOM Path: div#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE > span[data-csa-c-delivery-time="February 2 - 4"]
        console.log(`🔍 ${this._tag} Express delivery bilgisi aranıyor...`);
        const expressDeliverySelectors = [
          '#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE span[data-csa-c-delivery-time]', // Öncelikli - span içinde attribute var
          '#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE > span[data-csa-c-delivery-time]', // Direct child
          '#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE span', // Div içindeki span
          '#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE', // Div içinde text var
          'span[data-csa-c-delivery-time]', // Attribute'dan direkt çek (fallback)
          'span[data-csa-c-delivery-type="delivery"][data-csa-c-delivery-time]', // Delivery type ile birlikte
          '#deliveryBlockMessage span[data-csa-c-delivery-time]',
          '#deliveryBlockContainer span[data-csa-c-delivery-time]',
          'span:has-text("fastest delivery")',
          'span:has-text("Or fastest")',
          '#deliveryBlockMessage span:has-text("fastest")',
          '#deliveryBlockContainer span:has-text("fastest")'
        ];
        
        let fastestDeliveryText = null;
        for (const selector of expressDeliverySelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              // KRİTİK: Önce data-csa-c-delivery-time attribute'undan tarihi çek (tarih aralığı dahil)
              const deliveryTimeAttr = await element.getAttribute('data-csa-c-delivery-time');
              if (deliveryTimeAttr) {
                expressDeliveryDate = deliveryTimeAttr.trim();
                console.log(`✅ ${this._tag} Express delivery tarihi (attribute): ${expressDeliveryDate} (selector: ${selector})`);
              }
              
              // Text içeriğini de al
              const dateText = await element.textContent().then(t => t.trim()).catch(() => null);
              if (dateText) {
                fastestDeliveryText = dateText;
                console.log(`✅ ${this._tag} Fastest delivery text bulundu: ${fastestDeliveryText} (selector: ${selector})`);
                
                // Eğer attribute'dan tarih gelmediyse, text'ten çıkar
                if (!expressDeliveryDate) {
                  // KRİTİK: Tarih aralığı formatını kontrol et (örn: "Or fastest delivery February 2 - 4")
                  const dateRangeMatch = dateText.match(/(?:fastest|Or fastest).*?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2})/i);
                  if (dateRangeMatch) {
                    expressDeliveryDate = dateRangeMatch[1].trim();
                    console.log(`✅ ${this._tag} Hızlı gönderim tarihi (tarih aralığı): ${expressDeliveryDate}`);
                  } else {
                    // "Or fastest delivery Friday, January 23" formatından tarih çıkar
                    const dateMatch = dateText.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                    if (dateMatch) {
                      expressDeliveryDate = dateMatch[1].trim();
                      console.log(`✅ ${this._tag} Hızlı gönderim tarihi (text): ${expressDeliveryDate}`);
                    }
                  }
                }
                
                if (expressDeliveryDate || fastestDeliveryText) {
                  break;
                }
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        // KRİTİK: Eğer SECONDARY_DELIVERY_MESSAGE_LARGE div'i bulundu ama span bulunamadıysa, div içindeki tüm span'leri kontrol et
        if (!expressDeliveryDate && !fastestDeliveryText) {
          try {
            const secondaryDiv = await page.$('#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE');
            if (secondaryDiv) {
              console.log(`🔍 ${this._tag} SECONDARY_DELIVERY_MESSAGE_LARGE div bulundu, içindeki span'ler kontrol ediliyor...`);
              const spans = await secondaryDiv.$$('span');
              for (const span of spans) {
                try {
                  const deliveryTimeAttr = await span.getAttribute('data-csa-c-delivery-time');
                  if (deliveryTimeAttr) {
                    expressDeliveryDate = deliveryTimeAttr.trim();
                    console.log(`✅ ${this._tag} Express delivery tarihi (div içindeki span attribute): ${expressDeliveryDate}`);
                  }
                  
                  const dateText = await span.textContent().then(t => t.trim()).catch(() => null);
                  if (dateText && (dateText.includes('fastest') || dateText.includes('February') || dateText.includes('January') || dateText.includes('March'))) {
                    fastestDeliveryText = dateText;
                    console.log(`✅ ${this._tag} Fastest delivery text bulundu (div içindeki span): ${fastestDeliveryText}`);
                    
                    if (!expressDeliveryDate) {
                      const dateRangeMatch = dateText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2})/i);
                      if (dateRangeMatch) {
                        expressDeliveryDate = dateRangeMatch[1].trim();
                        console.log(`✅ ${this._tag} Hızlı gönderim tarihi (div içindeki span - tarih aralığı): ${expressDeliveryDate}`);
                      }
                    }
                    
                    if (expressDeliveryDate || fastestDeliveryText) {
                      break;
                    }
                  }
                } catch (e) {
                  continue;
                }
              }
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} SECONDARY_DELIVERY_MESSAGE_LARGE div kontrolü hatası: ${e.message}`);
          }
        }
        
        // Eğer hala express delivery bilgisi bulunamadıysa, delivery block içinde text arama
        if (!expressDeliveryDate) {
          console.log(`🔍 ${this._tag} Express delivery selector'larla bulunamadı, delivery block içinde aranıyor...`);
          try {
            const deliverySelectors = ['#deliveryBlockMessage', '#deliveryBlockContainer', '#deliveryBlock_feature_div'];
            for (const deliverySelector of deliverySelectors) {
              try {
                const deliveryElement = await page.$(deliverySelector);
                if (deliveryElement) {
                  const deliveryText = await deliveryElement.textContent();
                  if (deliveryText) {
                      // "fastest" veya "Or fastest" içeren kısmı bul
                      const fastestMatch = deliveryText.match(/([^.]*(?:fastest|Or fastest)[^.]*)/i);
                      if (fastestMatch) {
                        fastestDeliveryText = fastestMatch[1].trim();
                        console.log(`✅ ${this._tag} Fastest delivery text bulundu (delivery block): ${fastestDeliveryText}`);
                        
                        // KRİTİK: Tarih aralığı formatını kontrol et (örn: "Or fastest delivery February 2 - 4")
                        const dateRangeMatch = fastestDeliveryText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2})/i);
                        if (dateRangeMatch) {
                          expressDeliveryDate = dateRangeMatch[1].trim();
                          console.log(`✅ ${this._tag} Express delivery tarihi bulundu (delivery block - tarih aralığı): ${expressDeliveryDate}`);
                        } else {
                          // Tarih çıkar
                          const dateMatch = fastestDeliveryText.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                          if (dateMatch) {
                            expressDeliveryDate = dateMatch[1].trim();
                            console.log(`✅ ${this._tag} Express delivery tarihi bulundu (delivery block): ${expressDeliveryDate}`);
                          }
                        }
                        
                        break;
                      }
                  }
                }
              } catch (e) {
                continue;
              }
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} Express delivery block text arama hatası: ${e.message}`);
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Buybox delivery dates çekilemedi: ${e.message}`);
      }
      
      // KRİTİK: Fulfillment Type hesapla (FBA/FBM/SBA)
      // Mantık:
      // - Amazon satıp Amazon gönderiyorsa → SBA
      // - 3. parti satıcı satıp Amazon kargo yapıyorsa → FBA
      // - 3. parti satıcı satıp 3. parti satıcı gönderiyorsa → FBM
      // KRİTİK: "Shipper / Seller" label'ı varsa ve seller Amazon değilse → FBM
      let fulfillmentType = 'FBM'; // Default
      let isFBA = false;
      let isFBM = true; // Default
      let isSBA = false;
      
      try {
        // KRİTİK: "Shipper / Seller" label kontrolü
        let hasShipperSellerLabel = false;
        try {
          const shipperSellerLabel = await page.$('div#merchantInfoFeature_feature_div span.a-size-small.a-color-tertiary:has-text("Shipper / Seller")');
          if (shipperSellerLabel) {
            hasShipperSellerLabel = true;
            console.log(`✅ ${this._tag} "Shipper / Seller" label tespit edildi`);
          }
        } catch (e) {
          // Label kontrolü başarısız, devam et
        }
        
        const soldByLower = (soldBy || sellerName || '').toLowerCase().trim();
        const shipsFromLower = (shipsFrom || '').toLowerCase().trim();
        
        const isAmazonSeller = soldByLower.includes('amazon') || soldByLower === 'amazon.com' || soldByLower === 'amazon' || soldByLower === '';
        const isAmazonShipping = shipsFromLower.includes('amazon') || shipsFromLower === 'amazon.com' || shipsFromLower === 'amazon' || shipsFromLower === '';
        
        // KRİTİK: "Shipper / Seller" label'ı varsa ve seller Amazon değilse → FBM
        if (hasShipperSellerLabel && !isAmazonSeller && sellerName) {
          fulfillmentType = 'FBM';
          isSBA = false;
          isFBA = false;
          isFBM = true;
          console.log(`✅ ${this._tag} Buybox Fulfillment Type: FBM ("Shipper / Seller" label var ve seller 3. parti: ${sellerName})`);
        } else if (isAmazonSeller && isAmazonShipping) {
          fulfillmentType = 'SBA';
          isSBA = true;
          isFBA = false;
          isFBM = false;
          console.log(`✅ ${this._tag} Buybox Fulfillment Type: SBA (Amazon satıyor, Amazon gönderiyor)`);
        } else if (!isAmazonSeller && isAmazonShipping) {
          fulfillmentType = 'FBA';
          isSBA = false;
          isFBA = true;
          isFBM = false;
          console.log(`✅ ${this._tag} Buybox Fulfillment Type: FBA (3. parti satıcı satıyor, Amazon gönderiyor)`);
        } else {
          fulfillmentType = 'FBM';
          isSBA = false;
          isFBA = false;
          isFBM = true;
          console.log(`✅ ${this._tag} Buybox Fulfillment Type: FBM (3. parti satıcı satıyor, 3. parti satıcı gönderiyor)`);
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Buybox Fulfillment type hesaplanamadı: ${e.message}`);
        // Default: FBM
        fulfillmentType = 'FBM';
        isFBM = true;
        isFBA = false;
        isSBA = false;
      }
      
      // KRİTİK: Eğer shipping bilgileri hala null ise, buybox içinde daha detaylı arama yap
      if (!shippingPrice && !standardDeliveryDate && !expressDeliveryDate) {
        console.log(`⚠️ ${this._tag} Shipping bilgileri bulunamadı, buybox içinde detaylı arama yapılıyor...`);
        try {
          // Tüm buybox container'larını kontrol et
          const buyboxContainers = ['#desktop_buybox', '#buybox', '#qualifiedBuybox', '#apex_offerDisplay_single_desktop'];
          for (const containerSelector of buyboxContainers) {
            try {
              const container = await page.$(containerSelector);
              if (container) {
                const containerText = await container.textContent();
                if (containerText) {
                  // Shipping price ara
                  if (!shippingPrice) {
                    const shippingMatch = containerText.match(/[\$£€]?\s*([\d,]+\.?\d*)\s*(?:Shipping|delivery|Import)/i);
                    if (shippingMatch) {
                      shippingPrice = parseFloat(shippingMatch[1].replace(/,/g, ''));
                      console.log(`✅ ${this._tag} Shipping price buybox container'dan bulundu: ${shippingPrice}`);
                    }
                  }
                  
                  // Delivery date ara
                  if (!standardDeliveryDate) {
                    // KRİTİK: Tarih aralığı formatını kontrol et (örn: "February 9 - 19")
                    const dateRangeMatch = containerText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2})/i);
                    if (dateRangeMatch) {
                      standardDeliveryDate = dateRangeMatch[1].trim();
                      console.log(`✅ ${this._tag} Delivery date buybox container'dan bulundu (tarih aralığı): ${standardDeliveryDate}`);
                    } else {
                      const dateMatch = containerText.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                      if (dateMatch) {
                        standardDeliveryDate = dateMatch[1].trim();
                        console.log(`✅ ${this._tag} Delivery date buybox container'dan bulundu: ${standardDeliveryDate}`);
                      }
                    }
                  }
                  
                  // Express delivery ara
                  if (!expressDeliveryDate) {
                    // KRİTİK: Tarih aralığı formatını kontrol et (örn: "Or fastest delivery February 2 - 4")
                    const expressRangeMatch = containerText.match(/(?:fastest|Or fastest).*?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2})/i);
                    if (expressRangeMatch) {
                      expressDeliveryDate = expressRangeMatch[1].trim();
                      console.log(`✅ ${this._tag} Express delivery date buybox container'dan bulundu (tarih aralığı): ${expressDeliveryDate}`);
                    } else {
                      const expressMatch = containerText.match(/(?:fastest|Or fastest).*?((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                      if (expressMatch) {
                        expressDeliveryDate = expressMatch[1].trim();
                        console.log(`✅ ${this._tag} Express delivery date buybox container'dan bulundu: ${expressDeliveryDate}`);
                      }
                    }
                  }
                  
                  if (shippingPrice || standardDeliveryDate || expressDeliveryDate) {
                    break;
                  }
                }
              }
            } catch (e) {
              continue;
            }
          }
        } catch (e) {
          console.warn(`⚠️ ${this._tag} Buybox container detaylı arama hatası: ${e.message}`);
        }
      }
      
      // Buybox objesi oluştur - shipping bilgileri olsa da olmasa da döndür
      // KRİTİK: sellerName veya price yoksa bile, shipping bilgileri varsa döndür
      if (sellerName || price || shippingPrice || standardDeliveryDate || expressDeliveryDate) {
        return {
          sellerName: sellerName || null,
          soldBy: soldBy || sellerName || null,
          shipsFrom: shipsFrom || null,
          condition: condition,
          isNew: isNew,
          isUsed: isUsed,
          price: price,
          priceText: priceText || (price ? `$${price.toFixed(2)}` : null),
          primePrice: null, // Buybox için prime price ayrıca çekilmiyor
          primePriceText: null,
          // KRİTİK: Fulfillment Type (FBA/FBM/SBA)
          fulfillmentType: fulfillmentType,
          isFBA: isFBA,
          isFBM: isFBM,
          isSBA: isSBA,
          // KRİTİK: Gönderim fiyatları - Ayrı field'lar olarak
          shippingPrice: shippingPrice,
          standardShippingPrice: shippingPrice, // Standard shipping price
          expressShippingPrice: null, // Express shipping price (buybox için genellikle yok)
          shippingText: shippingText || null,
          // KRİTİK: Teslimat tarihleri
          deliveryDate: standardDeliveryDate, // Geriye dönük uyumluluk
          standardDeliveryDate: standardDeliveryDate,
          expressDeliveryDate: expressDeliveryDate,
          // KRİTİK: Satıcı değerlendirme bilgileri (buybox için genellikle yok ama field'ları ekle)
          sellerRating: null, // Buybox'ta satıcı rating genellikle gösterilmiyor
          sellerRatingCount: null,
          positivePercentage: null,
          isBuybox: true,
          index: 0
        };
      }
      
      // KRİTİK: Hiçbir bilgi yoksa bile null döndür (retry mekanizması çalışsın)
      console.warn(`⚠️ ${this._tag} Buybox bilgileri hiç bulunamadı (sellerName, price, shipping hepsi null)`);
      return null;
    } catch (e) {
      console.error(`❌ ${this._tag} Buybox data extraction hatası: ${e.message}`);
      return null;
    }
  }

  /**
   * Extract seller data from a single offer element
   * @param {Object} page - Playwright page object
   * @param {Object} offerElement - Playwright element handle for #aod-offer
   * @param {number} index - Offer index
   * @param {boolean} isPinnedOffer - Is this the pinned offer?
   * @returns {Promise<Object | null>}
   */
  async extractSellerDataFromOffer(page, offerElement, index, isPinnedOffer = false) {
    try {
      // KRİTİK: Sidebar açıldıktan sonra offer elementinden direkt veri oku
      // Önce offer element'inin text content'ini al (tüm bilgiler burada)
      const offerText = await offerElement.textContent().catch(() => '');
      console.log(`🔍 ${this._tag} Offer ${index} text content (ilk 200 karakter): ${offerText.substring(0, 200)}`);
      
      // KRİTİK: Boş veya anlamsız offer — fiyat, satıcı adı, condition hiçbiri yoksa atla
      // Amazon bazen "Currently unavailable" ürünler için boş #aod-offer DOM elementi bırakır
      const cleanedText = (offerText || '').replace(/\s+/g, ' ').trim();
      if (cleanedText.length < 10) {
        console.log(`⚠️ ${this._tag} Offer ${index} BOŞ veya çok kısa içerik (${cleanedText.length} karakter), atlanıyor`);
        return null;
      }
      // "Currently unavailable" veya "no sellers" mesajı varsa da atla
      if (/currently\s*unavailable/i.test(cleanedText) || /no\s+other\s+sellers\s+matching/i.test(cleanedText) || /we\s+don.*t\s+know\s+when/i.test(cleanedText)) {
        console.log(`⚠️ ${this._tag} Offer ${index} "unavailable/no sellers" mesajı içeriyor, atlanıyor`);
        return null;
      }
      
      // Condition (New, Used - Like New, Used - Very Good, vb.)
      let condition = null;
      let isNew = false;
      let isUsed = false;
      
      try {
        // KRİTİK: Önce offer element içinden condition'ı bul
        // "Used - Like New", "New", "Used - Very Good" gibi pattern'leri ara
        const conditionMatch = offerText.match(/(New|Used\s*-\s*(?:Like\s+New|Very\s+Good|Good|Acceptable)|Used)/i);
        if (conditionMatch) {
          condition = conditionMatch[1].trim();
          console.log(`✅ ${this._tag} Offer ${index} condition offer element'inden çekildi: ${condition}`);
        }
        
        // Eğer bulunamadıysa, sidebar'dan condition çek
        if (!condition) {
          if (isPinnedOffer) {
            try {
              const conditionElement = await page.$('#aod-offer-heading > span.a-size-base.a-text-bold').catch(() => null);
              if (conditionElement) {
                condition = await conditionElement.textContent().then(t => t.trim()).catch(() => null);
                if (condition) {
                  console.log(`✅ ${this._tag} Offer ${index} condition sidebar'dan çekildi: ${condition}`);
                }
              }
            } catch (e) {
              console.warn(`⚠️ ${this._tag} Offer ${index} condition sidebar'dan çekilemedi: ${e.message}`);
            }
          } else {
            // Diğer offer'lar için: offer içinde condition text'i bul
            try {
              const conditionElement = await offerElement.$('span#aod-condition-text, span.a-color-state, #aod-offer-heading span.a-size-base.a-text-bold').catch(() => null);
              if (conditionElement) {
                condition = await conditionElement.textContent().then(t => t.trim()).catch(() => null);
                if (condition) {
                  console.log(`✅ ${this._tag} Offer ${index} condition sidebar'dan çekildi: ${condition}`);
                }
              }
            } catch (e) {
              // Condition bulunamadı
            }
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Offer ${index} condition çekilirken hata: ${e.message}`);
      }
      
      // New/Used kontrolü - KRİTİK: Modal'da gösterilecek
      if (condition) {
        const conditionLower = condition.toLowerCase().trim();
        if (conditionLower === 'new' || conditionLower.startsWith('new')) {
          isNew = true;
          isUsed = false;
        } else if (conditionLower.includes('used') || conditionLower.startsWith('used')) {
          isNew = false;
          isUsed = true;
        }
      } else {
        // Condition bulunamadıysa, text içinde "New" veya "Used" ara
        try {
          const allText = await offerElement.textContent();
          const allTextLower = allText.toLowerCase();
          if (allTextLower.includes('new') && !allTextLower.includes('used')) {
            isNew = true;
            isUsed = false;
            condition = 'New';
          } else if (allTextLower.includes('used')) {
            isNew = false;
            isUsed = true;
            condition = 'Used';
          }
        } catch (e) {
          // Kontrol edilemedi
        }
      }
      
      // Price
      let price = null;
      let priceText = null;
      let primePriceData = null; // KRİTİK: try bloğu dışında tanımla — scope hatası düzeltildi
      try {
        // KRİTİK: Fiyatı CSS selector'larla oku — text regex YANLIŞ sonuç verir
        // (indirim yüzdesi "-29%" veya List Price yerine gerçek "Price to Pay" fiyatını yakalar)
        
        // ADIM 0: En güvenilir — "Price to Pay" elementi (centralizedApexPricePriceToPayMargin)
        // Bu Amazon'un "ödeyeceğiniz fiyat" elementi — List Price, Was Price vb. değil
        const priceToPayResult = await offerElement.evaluate((el) => {
          // centralizedApexPricePriceToPayMargin: Amazon'un "price to pay" elementi
          const ptpOffscreen = el.querySelector('span.centralizedApexPricePriceToPayMargin .a-offscreen');
          if (ptpOffscreen) {
            const text = ptpOffscreen.textContent.trim();
            const m = text.match(/[\$£€]\s*([\d,]+\.?\d*)/);
            if (m) return { price: parseFloat(m[1].replace(/,/g, '')), text: text };
          }
          // Fallback: aria-hidden span inside centralizedApexPricePriceToPayMargin
          const ptpAria = el.querySelector('span.centralizedApexPricePriceToPayMargin span[aria-hidden="true"]');
          if (ptpAria) {
            const text = ptpAria.textContent.trim().replace(/\s+/g, '');
            const m = text.match(/[\$£€]\s*([\d,]+\.?\d*)/);
            if (m) return { price: parseFloat(m[1].replace(/,/g, '')), text: text };
          }
          return null;
        }).catch(() => null);

        if (priceToPayResult && priceToPayResult.price > 0) {
          price = priceToPayResult.price;
          priceText = priceToPayResult.text;
          console.log(`✅ ${this._tag} Offer ${index} price PriceToPay (centralizedApexPricePriceToPayMargin): ${priceText} -> ${price}`);
        }
        
        // ADIM 1: Offer element içindeki .a-price .a-offscreen (List Price hariç)
        if (!price) {
          const priceFromElement = await offerElement.evaluate((el) => {
            // Önce ana fiyat element'ini bul (indirim/eski fiyat/List Price DEĞİL)
            const priceSpans = el.querySelectorAll('span.a-price:not([data-a-strike="true"]):not(.a-text-price) .a-offscreen');
            for (const span of priceSpans) {
              const text = span.textContent.trim();
              // İndirim yüzdesi filtresi
              if (text.includes('%') || text.toLowerCase().includes('off') || text.toLowerCase().includes('save')) continue;
              // KRİTİK: List Price filtresi — parent row'da "List Price" veya "Was:" varsa atla
              const parentRow = span.closest('.a-row, .a-section, div');
              if (parentRow) {
                const siblingText = parentRow.textContent.toLowerCase();
                if (siblingText.includes('list price') || siblingText.includes('was:') || siblingText.includes('price:')) {
                  // Ama "price to pay" içinde ise kabul et
                  const priceToPayParent = span.closest('.centralizedApexPricePriceToPayMargin');
                  if (!priceToPayParent) continue;
                }
              }
              const m = text.match(/[\$£€]\s*([\d,]+\.?\d*)/);
              if (m) return { price: parseFloat(m[1].replace(/,/g, '')), text: text };
            }
            // Fallback: tüm .a-offscreen (data-a-strike olmayan, List Price kontrollü)
            const allPriceEls = el.querySelectorAll('span.a-price .a-offscreen');
            for (const span of allPriceEls) {
              const text = span.textContent.trim();
              if (text.includes('%')) continue;
              // data-a-strike veya a-text-price parent varsa atla
              if (span.closest('[data-a-strike="true"]') || span.closest('.a-text-price')) continue;
              const m = text.match(/[\$£€]\s*([\d,]+\.?\d*)/);
              if (m) return { price: parseFloat(m[1].replace(/,/g, '')), text: text };
            }
            // Fallback: span[aria-hidden="true"] içinden fiyat (data-a-strike olmayan)
            const ariaHidden = el.querySelectorAll('span.a-price:not([data-a-strike="true"]):not(.a-text-price) span[aria-hidden="true"]');
            for (const span of ariaHidden) {
              const text = span.textContent.trim().replace(/\s+/g, '');
              if (text.includes('%')) continue;
              const m = text.match(/[\$£€]\s*([\d,]+\.?\d*)/);
              if (m) return { price: parseFloat(m[1].replace(/,/g, '')), text: text };
            }
            return null;
          }).catch(() => null);

          if (priceFromElement && priceFromElement.price > 0) {
            price = priceFromElement.price;
            priceText = priceFromElement.text;
            console.log(`✅ ${this._tag} Offer ${index} price CSS selector'dan çekildi: ${priceText} -> ${price}`);
          }
        }
        
        // ADIM 2: Bulunamadıysa sidebar'dan price çek (centralizedApexPricePriceToPayMargin öncelikli)
        if (!price) {
          const sidebarSelectors = isPinnedOffer
            ? [`#aod-price-0 span.centralizedApexPricePriceToPayMargin .a-offscreen`, `#aod-price-0 span.centralizedApexPricePriceToPayMargin span[aria-hidden="true"]`, '#aod-price-0 span.a-price:not([data-a-strike="true"]):not(.a-text-price) .a-offscreen']
            : [`#aod-price-${index} span.centralizedApexPricePriceToPayMargin .a-offscreen`, `#aod-price-${index} span.centralizedApexPricePriceToPayMargin span[aria-hidden="true"]`, `#aod-price-${index} span.a-price:not([data-a-strike="true"]):not(.a-text-price) .a-offscreen`, '#aod-price-0 span.centralizedApexPricePriceToPayMargin .a-offscreen'];
          for (const sel of sidebarSelectors) {
            try {
              const priceElement = await page.$(sel).catch(() => null);
              if (priceElement) {
                const rawText = await priceElement.textContent().then(t => t.trim()).catch(() => null);
                if (rawText && !rawText.includes('%')) {
                  const cleanedPriceText = rawText.replace(/\s+/g, '');
                  const pm = cleanedPriceText.match(/[\$£€]?([\d,]+\.?\d*)/);
                  if (pm) {
                    price = parseFloat(pm[1].replace(/,/g, ''));
                    priceText = rawText;
                    console.log(`✅ ${this._tag} Offer ${index} price sidebar'dan çekildi (${sel}): ${priceText} -> ${price}`);
                    break;
                  }
                }
              }
            } catch (e) { /* sonraki selector */ }
          }
        }
        
        // ADIM 3: Son çare — offerText'ten regex (List Price filtrelenmiş)
        if (!price) {
          // KRİTİK: Önce "List Price" satırını temizle — yanlış fiyat alınmasın
          const cleanedOfferText = offerText
            .replace(/List\s*Price[\s:]*[\$£€]?\s*[\d,.]+/gi, '')
            .replace(/Was[\s:]*[\$£€]?\s*[\d,.]+/gi, '')
            .replace(/Save[\s:]*[\$£€]?\s*[\d,.]+\s*\(\d+%\)/gi, '');
          const allPrices = [];
          const priceRegex = /[\$£€]\s*([\d,]+\.?\d{2})/g;
          let m;
          while ((m = priceRegex.exec(cleanedOfferText)) !== null) {
            const val = parseFloat(m[1].replace(/,/g, ''));
            if (val > 0 && val < 100000) allPrices.push({ val, text: m[0].trim() });
          }
          if (allPrices.length > 0) {
            // KRİTİK: İlk bulunan fiyatı al (genellikle satış fiyatı, List Price temizlendi)
            price = allPrices[0].val;
            priceText = allPrices[0].text;
            console.log(`✅ ${this._tag} Offer ${index} price text regex: ${priceText} -> ${price} (bulunan: ${allPrices.map(p => p.text).join(', ')})`);
          }
        }
        
        // ADIM 4: Prime member fiyatını çek (varsa)
        // Amazon AOD'de Prime fiyat genellikle farklı/düşük fiyat olarak gösterilir
        // Offer element'inde birden fazla fiyat varsa, düşük olan Prime fiyatı olabilir
        primePriceData = await offerElement.evaluate((el) => {
          // Tüm fiyat element'lerini topla
          const allPriceEls = el.querySelectorAll('span.a-price:not([data-a-strike="true"]) .a-offscreen');
          const prices = [];
          for (const span of allPriceEls) {
            const text = span.textContent.trim();
            if (text.includes('%')) continue;
            const m = text.match(/[\$£€]\s*([\d,]+\.?\d*)/);
            if (m) prices.push({ val: parseFloat(m[1].replace(/,/g, '')), text: text });
          }
          if (prices.length < 2) return null; // Sadece tek fiyat varsa prime fiyat yok
          // En düşük fiyat = Prime fiyat, en yüksek fiyat = normal fiyat
          prices.sort((a, b) => a.val - b.val);
          return { price: prices[0].val, text: prices[0].text };
        }).catch(() => null);
        
        // Eğer hala bulunamadıysa, normal yöntemi kullan
        if (!price && !priceText) {
          // Price selector'ları
          const priceSelectors = [
            'span.a-price .a-offscreen',
            'span.a-price-whole',
            'span.a-price span[aria-hidden="true"]',
            '.a-price'
          ];
          
          for (const selector of priceSelectors) {
            try {
              priceText = await offerElement.$eval(selector, (el) => {
                // .a-offscreen içindeki text'i al
                if (el.classList.contains('a-offscreen')) {
                  return el.textContent.trim();
                }
                // Veya parent'tan al
                const parent = el.closest('.a-price');
                if (parent) {
                  const offscreen = parent.querySelector('.a-offscreen');
                  if (offscreen) return offscreen.textContent.trim();
                  return parent.textContent.trim();
                }
                return el.textContent.trim();
              }).catch(() => null);
              
              if (priceText) {
                // Fiyatı parse et - "$134.99" -> 134.99
                const priceMatch = priceText.match(/[\$£€]?\s*([\d,]+\.?\d*)/);
                if (priceMatch) {
                  price = parseFloat(priceMatch[1].replace(/,/g, ''));
                }
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          // Eğer hala bulunamadıysa, tüm text'ten çıkar
          if (!price && !priceText) {
            const allText = await offerElement.textContent();
            const priceMatch = allText.match(/[\$£€]?\s*([\d,]+\.?\d*)/);
            if (priceMatch) {
              price = parseFloat(priceMatch[1].replace(/,/g, ''));
              priceText = priceMatch[0];
            }
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Price çekilemedi: ${e.message}`);
      }
      
      // Ships from
      let shipsFrom = null;
      try {
        // KRİTİK: Önce offer element içinden shipsFrom'u bul
        // "Ships from Amazon.com" formatından "Amazon.com" çıkar
        const shipsFromMatch = offerText.match(/Ships from\s+([^\n\r]+)/i);
        if (shipsFromMatch) {
          shipsFrom = shipsFromMatch[1].trim();
          console.log(`✅ ${this._tag} Offer ${index} shipsFrom offer element'inden çekildi: ${shipsFrom}`);
        }
        
        // Eğer bulunamadıysa, sidebar'dan shipsFrom çek
        if (!shipsFrom) {
          // KRİTİK: Sidebar'dan shipsFrom çek
          // Pinned offer için: #aod-offer-shipsFrom (global)
          // Diğer offer'lar için: offer içinde #aod-offer-shipsFrom veya text içinde
          if (isPinnedOffer) {
            try {
              const shipsFromElement = await page.$('#aod-offer-shipsFrom').catch(() => null);
              if (shipsFromElement) {
                const shipsFromText = await shipsFromElement.textContent().then(t => t.trim()).catch(() => null);
                if (shipsFromText) {
                  // "Ships from Amazon.com" formatından "Amazon.com" çıkar
                  const shipsFromMatch = shipsFromText.match(/Ships from\s+(.+)/i);
                  if (shipsFromMatch) {
                    shipsFrom = shipsFromMatch[1].trim();
                    console.log(`✅ ${this._tag} Offer ${index} shipsFrom sidebar'dan çekildi: ${shipsFrom}`);
                  } else {
                    shipsFrom = shipsFromText.replace(/Ships from\s*/i, '').trim();
                  }
                }
              }
            } catch (e) {
              console.warn(`⚠️ ${this._tag} Offer ${index} shipsFrom sidebar'dan çekilemedi: ${e.message}`);
            }
          } else {
            // Diğer offer'lar için: offer içinde shipsFrom bul
            try {
              const shipsFromElement = await offerElement.$('#aod-offer-shipsFrom, [id*="shipsFrom"]').catch(() => null);
              if (shipsFromElement) {
                const shipsFromText = await shipsFromElement.textContent().then(t => t.trim()).catch(() => null);
                if (shipsFromText) {
                  const shipsFromMatch = shipsFromText.match(/Ships from\s+(.+)/i);
                  if (shipsFromMatch) {
                    shipsFrom = shipsFromMatch[1].trim();
                    console.log(`✅ ${this._tag} Offer ${index} shipsFrom sidebar'dan çekildi: ${shipsFrom}`);
                  } else {
                    shipsFrom = shipsFromText.replace(/Ships from\s*/i, '').trim();
                  }
                }
              }
            } catch (e) {
              // Ships from bulunamadı
            }
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Offer ${index} shipsFrom çekilirken hata: ${e.message}`);
      }
      
      // Sold by
      let soldBy = null;
      let sellerName = null;
      let sellerRating = null;
      let sellerRatingCount = null;
      let positivePercentage = null;
      try {
        // KRİTİK: Önce offer element içinden soldBy'yi bul
        // "Sold by ..." metninden çıkar
        const soldByMatch = offerText.match(/Sold by\s+([^\n\r]+?)(?:\s+Seller rating|$)/i);
        if (soldByMatch) {
          soldBy = soldByMatch[1].trim();
          sellerName = soldBy;
          console.log(`✅ ${this._tag} Offer ${index} soldBy offer element'inden çekildi: ${soldBy} -> sellerName: ${sellerName}`);
        }
        
        // Seller rating - "Seller rating is 5 out of 5 stars"
        const ratingMatch = offerText.match(/(\d+(?:\.\d+)?)\s+out of\s+5\s+stars/i);
        if (ratingMatch) {
          sellerRating = parseFloat(ratingMatch[1]);
          console.log(`✅ ${this._tag} Offer ${index} sellerRating offer element'inden çekildi: ${sellerRating}`);
        }
        
        // KRİTİK: Seller rating count - "(77 ratings)" veya "(1,234 ratings)" formatından çıkar
        const ratingCountMatch = offerText.match(/\((\d{1,3}(?:,\d{3})*|\d+)\s*(?:ratings?|değerlendirme)\)/i);
        if (ratingCountMatch) {
          sellerRatingCount = ratingCountMatch[1].replace(/,/g, '');
          console.log(`✅ ${this._tag} Offer ${index} sellerRatingCount offer element'inden çekildi: ${sellerRatingCount}`);
        }
        
        // KRİTİK: Positive percentage - "100% positive" veya "98% positive" formatından çıkar
        const positiveMatch = offerText.match(/(\d+(?:\.\d+)?)\s*%\s*positive/i);
        if (positiveMatch) {
          positivePercentage = parseFloat(positiveMatch[1]);
          console.log(`✅ ${this._tag} Offer ${index} positivePercentage offer element'inden çekildi: ${positivePercentage}%`);
        }
        
        // Eğer bulunamadıysa, sidebar'dan soldBy çek
        if (!soldBy) {
          // KRİTİK: Sidebar'dan soldBy çek
          // Pinned offer için: #aod-offer-soldBy (global)
          // Diğer offer'lar için: offer içinde #aod-offer-soldBy veya text içinde
          if (isPinnedOffer) {
            try {
              const soldByElement = await page.$('#aod-offer-soldBy').catch(() => null);
              if (soldByElement) {
                const soldByText = await soldByElement.textContent().then(t => t.trim()).catch(() => null);
                if (soldByText) {
                  // "Sold by vancasso Reactive Art Seller rating is 5 out of 5 stars..." formatından çıkar
                  const soldByMatch = soldByText.match(/Sold by\s+([^\n\r]+?)(?:\s+Seller rating|$)/i);
                  if (soldByMatch) {
                    soldBy = soldByMatch[1].trim();
                    sellerName = soldBy;
                    console.log(`✅ ${this._tag} Offer ${index} soldBy sidebar'dan çekildi: ${soldBy} -> sellerName: ${sellerName}`);
                  }
                  
                  // Seller rating - "Seller rating is 5 out of 5 stars (77 ratings)"
                  if (!sellerRating) {
                    const ratingMatch = soldByText.match(/(\d+(?:\.\d+)?)\s+out of\s+5\s+stars/i);
                    if (ratingMatch) {
                      sellerRating = parseFloat(ratingMatch[1]);
                      console.log(`✅ ${this._tag} Offer ${index} sellerRating sidebar'dan çekildi: ${sellerRating}`);
                    }
                  }
                  
                  // KRİTİK: Seller rating count - "(77 ratings)" formatından çıkar
                  if (!sellerRatingCount) {
                    const ratingCountMatch = soldByText.match(/\((\d{1,3}(?:,\d{3})*|\d+)\s*(?:ratings?|değerlendirme)\)/i);
                    if (ratingCountMatch) {
                      sellerRatingCount = ratingCountMatch[1].replace(/,/g, '');
                      console.log(`✅ ${this._tag} Offer ${index} sellerRatingCount sidebar'dan çekildi: ${sellerRatingCount}`);
                    }
                  }
                  
                  // KRİTİK: Positive percentage - "100% positive" formatından çıkar
                  if (!positivePercentage) {
                    const positiveMatch = soldByText.match(/(\d+(?:\.\d+)?)\s*%\s*positive/i);
                    if (positiveMatch) {
                      positivePercentage = parseFloat(positiveMatch[1]);
                      console.log(`✅ ${this._tag} Offer ${index} positivePercentage sidebar'dan çekildi: ${positivePercentage}%`);
                    }
                  }
                }
              }
              
              // KRİTİK: Pinned offer için #aod-offer-seller-rating elementinden rating bilgilerini çek
              if (!sellerRating || !sellerRatingCount || !positivePercentage) {
                try {
                  const ratingElement = await page.$('#aod-offer-seller-rating, span#seller-rating-count-0').catch(() => null);
                  if (ratingElement) {
                    const ratingText = await ratingElement.textContent().then(t => t.trim()).catch(() => null);
                    if (ratingText) {
                      console.log(`🔍 ${this._tag} Pinned offer rating text: ${ratingText.substring(0, 200)}`);
                      
                      // Seller rating
                      if (!sellerRating) {
                        const ratingMatch = ratingText.match(/(?:Seller rating is\s+)?(\d+(?:\.\d+)?)\s+out of\s+5\s+stars/i);
                        if (ratingMatch) {
                          sellerRating = parseFloat(ratingMatch[1]);
                          console.log(`✅ ${this._tag} Pinned offer sellerRating #aod-offer-seller-rating'den çekildi: ${sellerRating}`);
                        }
                      }
                      
                      // Seller rating count
                      if (!sellerRatingCount) {
                        const ratingCountMatch = ratingText.match(/\((\d{1,3}(?:,\d{3})*|\d+)\s*(?:ratings?|değerlendirme)\)/i);
                        if (ratingCountMatch) {
                          sellerRatingCount = ratingCountMatch[1].replace(/,/g, '');
                          console.log(`✅ ${this._tag} Pinned offer sellerRatingCount #aod-offer-seller-rating'den çekildi: ${sellerRatingCount}`);
                        }
                      }
                      
                      // Positive percentage
                      if (!positivePercentage) {
                        const positiveMatch = ratingText.match(/(\d+(?:\.\d+)?)\s*%\s*positive/i);
                        if (positiveMatch) {
                          positivePercentage = parseFloat(positiveMatch[1]);
                          console.log(`✅ ${this._tag} Pinned offer positivePercentage #aod-offer-seller-rating'den çekildi: ${positivePercentage}%`);
                        }
                      }
                    }
                  }
                } catch (ratingError) {
                  console.warn(`⚠️ ${this._tag} Pinned offer rating bilgileri çekilirken hata: ${ratingError.message}`);
                }
              }
            } catch (e) {
              console.warn(`⚠️ ${this._tag} Offer ${index} soldBy sidebar'dan çekilemedi: ${e.message}`);
            }
          } else {
            // Diğer offer'lar için: offer içinde soldBy bul
            try {
              const soldByElement = await offerElement.$('#aod-offer-soldBy, [id*="soldBy"]').catch(() => null);
              if (soldByElement) {
                const soldByText = await soldByElement.textContent().then(t => t.trim()).catch(() => null);
                if (soldByText) {
                  const soldByMatch = soldByText.match(/Sold by\s+([^\n\r]+?)(?:\s+Seller rating|$)/i);
                  if (soldByMatch) {
                    soldBy = soldByMatch[1].trim();
                    sellerName = soldBy;
                    console.log(`✅ ${this._tag} Offer ${index} soldBy sidebar'dan çekildi: ${soldBy} -> sellerName: ${sellerName}`);
                  }
                  
                  // Seller rating
                  if (!sellerRating) {
                    const ratingMatch = soldByText.match(/(\d+(?:\.\d+)?)\s+out of\s+5\s+stars/i);
                    if (ratingMatch) {
                      sellerRating = parseFloat(ratingMatch[1]);
                      console.log(`✅ ${this._tag} Offer ${index} sellerRating sidebar'dan çekildi: ${sellerRating}`);
                    }
                  }
                  
                  // KRİTİK: Seller rating count - "(77 ratings)" formatından çıkar
                  if (!sellerRatingCount) {
                    const ratingCountMatch = soldByText.match(/\((\d{1,3}(?:,\d{3})*|\d+)\s*(?:ratings?|değerlendirme)\)/i);
                    if (ratingCountMatch) {
                      sellerRatingCount = ratingCountMatch[1].replace(/,/g, '');
                      console.log(`✅ ${this._tag} Offer ${index} sellerRatingCount sidebar'dan çekildi: ${sellerRatingCount}`);
                    }
                  }
                  
                  // KRİTİK: Positive percentage - "100% positive" formatından çıkar
                  if (!positivePercentage) {
                    const positiveMatch = soldByText.match(/(\d+(?:\.\d+)?)\s*%\s*positive/i);
                    if (positiveMatch) {
                      positivePercentage = parseFloat(positiveMatch[1]);
                      console.log(`✅ ${this._tag} Offer ${index} positivePercentage sidebar'dan çekildi: ${positivePercentage}%`);
                    }
                  }
                }
              }
            } catch (e) {
              // Sold by bulunamadı
            }
          }
          
          // Eğer hala bulunamadıysa, satıcı linki: a[href*="/sp?seller="]
          if (!soldBy) {
            const sellerLinkSelectors = [
              'a[href*="/sp?seller="]',
              'a#sellerProfileTriggerId',
              'a[href*="seller"]',
              '.aod-information-block a[href*="seller"]'
            ];
            
            for (const selector of sellerLinkSelectors) {
              try {
                const sellerLink = await offerElement.$(selector).catch(() => null);
                if (sellerLink) {
                  const t = await sellerLink.textContent().then(x => x && x.trim()).catch(() => null);
                  if (t) {
                    // "Sold by X" formatından sadece X'i çıkar
                    const soldByMatch = t.match(/Sold by\s+(.+?)(?:\s+Seller rating|\s*$)/i);
                    if (soldByMatch) {
                      soldBy = soldByMatch[1].trim();
                      sellerName = soldBy;
                    } else {
                      soldBy = t;
                      sellerName = soldBy;
                    }
                    
                    // Seller ID'yi link'ten çek
                    const href = await sellerLink.getAttribute('href').catch(() => '');
                    if (href) {
                      const sellerIdMatch = href.match(/seller=([A-Z0-9]+)/i);
                      if (sellerIdMatch) {
                        // sellerId field'ı yoksa eklenebilir
                      }
                    }
                    
                    if (soldBy) {
                      console.log(`✅ ${this._tag} Offer ${index} soldBy link'ten çekildi: ${soldBy}`);
                      break;
                    }
                  }
                }
              } catch (e) {
                continue;
              }
            }
          }
          
          // Eğer hala bulunamadıysa, tüm offer text'inden ara
          if (!soldBy) {
            try {
              const fullText = await offerElement.textContent().catch(() => '');
              if (fullText) {
                const soldByMatch = fullText.match(/Sold by\s+([^\n\r]+?)(?:\s+Ships from|\s+Seller rating|\s*$)/i);
                if (soldByMatch) {
                  soldBy = soldByMatch[1].trim();
                  sellerName = soldBy;
                  console.log(`✅ ${this._tag} Offer ${index} soldBy full text'ten çekildi: ${soldBy}`);
                }
              }
            } catch (e) {
              // Full text parse başarısız
            }
          }
          
          // Pinned değilse: tıklanan offer için sidebar #aod-offer-soldBy (getSellerInfo'da tıklama yapıldı)
          if (!soldBy && !isPinnedOffer) {
            const globalSoldBy = await page.$('#aod-offer-soldBy').catch(() => null);
            if (globalSoldBy) {
              const t = await globalSoldBy.textContent().then(x => x && x.trim()).catch(() => null);
              if (t) {
                const m = t.match(/Sold by\s+([^\n\r]+?)(?:\s+Seller rating|$)/i);
                if (m) { soldBy = m[1].trim(); sellerName = soldBy; }
                if (!sellerRating) {
                  const ratingMatch = t.match(/(\d+(?:\.\d+)?)\s+out of\s+5\s+stars/i);
                  if (ratingMatch) sellerRating = parseFloat(ratingMatch[1]);
                }
                // KRİTİK: Seller rating count
                if (!sellerRatingCount) {
                  const ratingCountMatch = t.match(/\((\d{1,3}(?:,\d{3})*|\d+)\s*(?:ratings?|değerlendirme)\)/i);
                  if (ratingCountMatch) sellerRatingCount = ratingCountMatch[1].replace(/,/g, '');
                }
                // KRİTİK: Positive percentage
                if (!positivePercentage) {
                  const positiveMatch = t.match(/(\d+(?:\.\d+)?)\s*%\s*positive/i);
                  if (positiveMatch) positivePercentage = parseFloat(positiveMatch[1]);
                }
              }
            }
          }
          
          // KRİTİK: Satıcı değerlendirmelerini #aod-offer-seller-rating elementinden çek
          // Pinned offer için: #aod-offer-seller-rating (global)
          // Diğer offer'lar için: offer içinde #aod-offer-seller-rating veya #seller-rating-count-{iter}
          if (!sellerRating || !sellerRatingCount || !positivePercentage) {
            try {
              let ratingElement = null;
              if (isPinnedOffer) {
                // Pinned offer için global selector
                ratingElement = await page.$('#aod-offer-seller-rating').catch(() => null);
              } else {
                // Diğer offer'lar için: offer içinde veya global
                ratingElement = await offerElement.$('#aod-offer-seller-rating, [id*="seller-rating"]').catch(() => null);
                if (!ratingElement) {
                  // Global selector'ı dene
                  ratingElement = await page.$(`#aod-offer-seller-rating, #seller-rating-count-${index}`).catch(() => null);
                }
              }
              
              if (ratingElement) {
                const ratingText = await ratingElement.textContent().then(t => t.trim()).catch(() => null);
                if (ratingText) {
                  console.log(`🔍 ${this._tag} Offer ${index} rating text: ${ratingText.substring(0, 200)}`);
                  
                  // Seller rating - "Seller rating is 5 out of 5 stars" veya "5 out of 5 stars"
                  if (!sellerRating) {
                    const ratingMatch = ratingText.match(/(?:Seller rating is\s+)?(\d+(?:\.\d+)?)\s+out of\s+5\s+stars/i);
                    if (ratingMatch) {
                      sellerRating = parseFloat(ratingMatch[1]);
                      console.log(`✅ ${this._tag} Offer ${index} sellerRating #aod-offer-seller-rating'den çekildi: ${sellerRating}`);
                    }
                  }
                  
                  // KRİTİK: Seller rating count - "(33 ratings)" veya "(1 rating)" formatından çıkar
                  if (!sellerRatingCount) {
                    const ratingCountMatch = ratingText.match(/\((\d{1,3}(?:,\d{3})*|\d+)\s*(?:ratings?|değerlendirme)\)/i);
                    if (ratingCountMatch) {
                      sellerRatingCount = ratingCountMatch[1].replace(/,/g, '');
                      console.log(`✅ ${this._tag} Offer ${index} sellerRatingCount #aod-offer-seller-rating'den çekildi: ${sellerRatingCount}`);
                    }
                  }
                  
                  // KRİTİK: Positive percentage - "100% positive over last 12 months" formatından çıkar
                  if (!positivePercentage) {
                    const positiveMatch = ratingText.match(/(\d+(?:\.\d+)?)\s*%\s*positive/i);
                    if (positiveMatch) {
                      positivePercentage = parseFloat(positiveMatch[1]);
                      console.log(`✅ ${this._tag} Offer ${index} positivePercentage #aod-offer-seller-rating'den çekildi: ${positivePercentage}%`);
                    }
                  }
                }
              }
            } catch (ratingError) {
              console.warn(`⚠️ ${this._tag} Offer ${index} rating bilgileri çekilirken hata: ${ratingError.message}`);
            }
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Offer ${index} soldBy çekilirken hata: ${e.message}`);
      }
      
      // Delivery date ve shipping price
      let deliveryDate = null;
      let shippingPrice = null;
      let expressDeliveryDate = null;
      try {
        // KRİTİK: Önce offer element içinden delivery bilgilerini çek
        // Tek tarih: "$30.96 delivery Tuesday, January 27"
        // Tarih aralığı: "$21.94 delivery March 2 - 19" veya "$24 delivery February 27 - March 13"
        const months = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
        const days = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
        
        // 1. Tek tarih formatı: "$30.96 delivery Tuesday, January 27"
        const deliveryMatch = offerText.match(new RegExp(`[\\$£€]?\\s*([\\d,]+\\.?\\d*)\\s+delivery\\s+(${days},?\\s+${months}\\s+\\d{1,2})`, 'i'));
        if (deliveryMatch) {
          shippingPrice = parseFloat(deliveryMatch[1].replace(/,/g, ''));
          deliveryDate = deliveryMatch[2].trim();
          console.log(`✅ ${this._tag} Offer ${index} delivery offer element'inden çekildi: shippingPrice: ${shippingPrice}, deliveryDate: ${deliveryDate}`);
        } else {
          // 2. Tarih aralığı formatı: "$21.94 delivery March 2 - 19"
          const rangeDeliveryMatch = offerText.match(new RegExp(`[\\$£€]?\\s*([\\d,]+\\.?\\d*)\\s+delivery\\s+(${months}\\s+\\d{1,2}\\s*-\\s*(?:${months}\\s+)?\\d{1,2})`, 'i'));
          if (rangeDeliveryMatch) {
            shippingPrice = parseFloat(rangeDeliveryMatch[1].replace(/,/g, ''));
            deliveryDate = rangeDeliveryMatch[2].trim();
            console.log(`✅ ${this._tag} Offer ${index} delivery (aralık) offer element'inden çekildi: shippingPrice: ${shippingPrice}, deliveryDate: ${deliveryDate}`);
          } else {
            // Sadece shipping price
            const shippingMatch = offerText.match(/[\$£€]?\s*([\d,]+\.?\d*)\s+delivery/i);
            if (shippingMatch) {
              shippingPrice = parseFloat(shippingMatch[1].replace(/,/g, ''));
              console.log(`✅ ${this._tag} Offer ${index} shippingPrice offer element'inden çekildi: ${shippingPrice}`);
            }
            
            // Sadece delivery date (tek tarih)
            const dateMatch = offerText.match(new RegExp(`(${days},?\\s+${months}\\s+\\d{1,2})`, 'i'));
            if (dateMatch) {
              deliveryDate = dateMatch[1].trim();
              console.log(`✅ ${this._tag} Offer ${index} deliveryDate offer element'inden çekildi: ${deliveryDate}`);
            }
          }
        }
        
        // Express delivery - "Or fastest delivery Friday, January 23" veya "Or fastest delivery March 2 - 16"
        const expressMatch = offerText.match(new RegExp(`fastest\\s+delivery\\s+((?:${days},?\\s+)?${months}\\s+\\d{1,2}(?:\\s*-\\s*(?:${months}\\s+)?\\d{1,2})?)`, 'i'));
        if (expressMatch) {
          expressDeliveryDate = expressMatch[1].trim();
          console.log(`✅ ${this._tag} Offer ${index} expressDeliveryDate offer element'inden çekildi: ${expressDeliveryDate}`);
        }
        
        // Eğer bulunamadıysa, offer element içinden delivery bilgilerini çek
        if (!deliveryDate && !shippingPrice && !expressDeliveryDate) {
          if (isPinnedOffer) {
            // Pinned offer: global selector ile
            try {
              const standardDeliveryElement = await page.$('#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE > span').catch(() => null);
              if (standardDeliveryElement) {
                const standardDeliveryText = await standardDeliveryElement.textContent().then(t => t.trim()).catch(() => null);
                if (standardDeliveryText) {
                  const shippingMatch = standardDeliveryText.match(/[\$£€]?\s*([\d,]+\.?\d*)\s+delivery/i);
                  if (shippingMatch) shippingPrice = parseFloat(shippingMatch[1].replace(/,/g, ''));
                  const dateMatch = standardDeliveryText.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                  if (dateMatch) deliveryDate = dateMatch[1].trim();
                  console.log(`✅ ${this._tag} Offer ${index} standard delivery sidebar'dan çekildi: ${standardDeliveryText} -> shippingPrice: ${shippingPrice}, deliveryDate: ${deliveryDate}`);
                }
              }
              const expressDeliveryElement = await page.$('#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE > span').catch(() => null);
              if (expressDeliveryElement) {
                const expressDeliveryText = await expressDeliveryElement.textContent().then(t => t.trim()).catch(() => null);
                if (expressDeliveryText) {
                  const dateMatch = expressDeliveryText.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                  if (dateMatch) {
                    expressDeliveryDate = dateMatch[1].trim();
                    console.log(`✅ ${this._tag} Offer ${index} express delivery sidebar'dan çekildi: ${expressDeliveryText} -> expressDeliveryDate: ${expressDeliveryDate}`);
                  }
                }
              }
            } catch (e) {
              console.warn(`⚠️ ${this._tag} Offer ${index} delivery sidebar'dan çekilemedi: ${e.message}`);
            }
          } else {
            // KRİTİK: Non-pinned offer'lar için data-csa-c-delivery-time attribute'undan çek
            try {
              const deliveryData = await offerElement.evaluate((el) => {
                const spans = el.querySelectorAll('span[data-csa-c-delivery-time]');
                let standard = null;
                let express = null;
                let stdPrice = null;
                for (const span of spans) {
                  const deliveryTime = span.getAttribute('data-csa-c-delivery-time') || '';
                  const deliveryPrice = span.getAttribute('data-csa-c-delivery-price') || '';
                  const text = span.textContent.trim();
                  if (deliveryPrice === 'fastest' || text.toLowerCase().includes('fastest')) {
                    express = deliveryTime;
                  } else if (deliveryTime) {
                    standard = deliveryTime;
                    // "$21.94 delivery" → 21.94
                    const pm = deliveryPrice.match(/[\d,.]+/);
                    if (pm) stdPrice = parseFloat(pm[0].replace(/,/g, ''));
                  }
                }
                // Fallback: delivery-promise span'lardan text ile çek
                if (!standard && !express) {
                  const allText = el.textContent || '';
                  // Tarih aralığı: "March 2 - 19", "February 27 - March 13"
                  const rangeMatch = allText.match(/delivery\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+)?\d{1,2})/i);
                  if (rangeMatch) standard = rangeMatch[1].trim();
                  // Tek tarih: "delivery Monday, January 26"
                  if (!standard) {
                    const singleMatch = allText.match(/delivery\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2})/i);
                    if (singleMatch) standard = singleMatch[1].trim();
                  }
                  // Express: "fastest delivery ..."
                  const expressMatch = allText.match(/fastest\s+delivery\s+((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:\s*-\s*(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+)?\d{1,2})?)/i);
                  if (expressMatch) express = expressMatch[1].trim();
                }
                return { standard, express, stdPrice };
              }).catch(() => ({ standard: null, express: null, stdPrice: null }));
              
              if (deliveryData.standard) {
                deliveryDate = deliveryData.standard;
                console.log(`✅ ${this._tag} Offer ${index} deliveryDate offer element'inden (attribute) çekildi: ${deliveryDate}`);
              }
              if (deliveryData.express) {
                expressDeliveryDate = deliveryData.express;
                console.log(`✅ ${this._tag} Offer ${index} expressDeliveryDate offer element'inden (attribute) çekildi: ${expressDeliveryDate}`);
              }
              if (deliveryData.stdPrice && !shippingPrice) {
                shippingPrice = deliveryData.stdPrice;
                console.log(`✅ ${this._tag} Offer ${index} shippingPrice offer element'inden (attribute) çekildi: ${shippingPrice}`);
              }
            } catch (e) {
              console.warn(`⚠️ ${this._tag} Offer ${index} delivery offer element'inden çekilemedi: ${e.message}`);
            }
          }
        }
        
        // KRİTİK: Hala bulunamadıysa, tarih aralığı regex ile tekrar dene (offerText'ten)
        if (!deliveryDate) {
          try {
            // "March 2 - 19", "February 27 - March 13" gibi tarih aralıkları
            const rangeMatch = offerText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+)?\d{1,2})/i);
            if (rangeMatch) {
              deliveryDate = rangeMatch[1].trim();
              console.log(`✅ ${this._tag} Offer ${index} deliveryDate tarih aralığı regex ile çekildi: ${deliveryDate}`);
            }
          } catch (e) { /* ignore */ }
        }
        if (!expressDeliveryDate) {
          try {
            const expressRangeMatch = offerText.match(/fastest\s+delivery\s+((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:\s*-\s*(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+)?\d{1,2})?)/i);
            if (expressRangeMatch) {
              expressDeliveryDate = expressRangeMatch[1].trim();
              console.log(`✅ ${this._tag} Offer ${index} expressDeliveryDate tarih aralığı regex ile çekildi: ${expressDeliveryDate}`);
            }
          } catch (e) { /* ignore */ }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Offer ${index} delivery bilgisi çekilirken hata: ${e.message}`);
      }
      
      // KRİTİK: "Cannot be shipped" kontrolü — hedef ülkeye gönderim yapılamıyorsa
      let cannotShip = false;
      try {
        // offerText içinde "cannot be shipped" veya "can't be shipped" kontrolü
        if (offerText && /cannot be shipped|can't be shipped|can not be shipped|unable to ship|doesn't ship/i.test(offerText)) {
          cannotShip = true;
          console.log(`⚠️ ${this._tag} Offer ${index} hedef ülkeye gönderim yapılamıyor (cannot be shipped)`);
          // Cannot ship durumunda shipping price ve delivery date'leri temizle
          shippingPrice = null;
          deliveryDate = 'CANNOT_SHIP';
          expressDeliveryDate = null;
        }
        // Eğer offerText'te bulamadıysak, offer element içinde error mesajı ara
        if (!cannotShip) {
          const errorSpan = await offerElement.$('span.a-color-error, .a-alert-content').catch(() => null);
          if (errorSpan) {
            const errorText = await errorSpan.textContent().then(t => t.trim()).catch(() => '');
            if (errorText && /cannot be shipped|can't be shipped|unable to ship/i.test(errorText)) {
              cannotShip = true;
              console.log(`⚠️ ${this._tag} Offer ${index} hedef ülkeye gönderim yapılamıyor (error span): ${errorText}`);
              shippingPrice = null;
              deliveryDate = 'CANNOT_SHIP';
              expressDeliveryDate = null;
            }
          }
        }
      } catch (e) {
        // Cannot ship kontrolü başarısız — devam et
      }
      
      // KRİTİK: Fulfillment Type hesapla (FBA/FBM/SBA)
      // Mantık:
      // - Amazon satıp Amazon gönderiyorsa → SBA
      // - 3. parti satıcı satıp Amazon kargo yapıyorsa → FBA
      // - 3. parti satıcı satıp 3. parti satıcı gönderiyorsa → FBM
      let fulfillmentType = 'FBM'; // Default
      let isFBA = false;
      let isFBM = true; // Default
      let isSBA = false;
      
      try {
        const soldByLower = (soldBy || sellerName || '').toLowerCase().trim();
        const shipsFromLower = (shipsFrom || '').toLowerCase().trim();
        
        const isAmazonSeller = soldByLower.includes('amazon') || soldByLower === 'amazon.com' || soldByLower === 'amazon' || soldByLower === '';
        const isAmazonShipping = shipsFromLower.includes('amazon') || shipsFromLower === 'amazon.com' || shipsFromLower === 'amazon' || shipsFromLower === '';
        
        if (isAmazonSeller && isAmazonShipping) {
          fulfillmentType = 'SBA';
          isSBA = true;
          isFBA = false;
          isFBM = false;
          console.log(`✅ ${this._tag} Offer ${index} Fulfillment Type: SBA (Amazon satıyor, Amazon gönderiyor)`);
        } else if (!isAmazonSeller && isAmazonShipping) {
          fulfillmentType = 'FBA';
          isSBA = false;
          isFBA = true;
          isFBM = false;
          console.log(`✅ ${this._tag} Offer ${index} Fulfillment Type: FBA (3. parti satıcı satıyor, Amazon gönderiyor)`);
        } else {
          fulfillmentType = 'FBM';
          isSBA = false;
          isFBA = false;
          isFBM = true;
          console.log(`✅ ${this._tag} Offer ${index} Fulfillment Type: FBM (3. parti satıcı satıyor, 3. parti satıcı gönderiyor)`);
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Offer ${index} Fulfillment type hesaplanamadı: ${e.message}`);
        // Default: FBM
        fulfillmentType = 'FBM';
        isFBM = true;
        isFBA = false;
        isSBA = false;
      }
      
      // KRİTİK: SBA (Amazon satıyor) ve seller bilgisi yoksa "Amazon" kullan — frontend merge eşleşebilsin
      const nameForMerge = (soldBy || sellerName || '').trim();
      const isNameEmpty = !nameForMerge || nameForMerge.toLowerCase() === 'n/a' || nameForMerge.toLowerCase() === 'n.a.';
      if (isSBA && isNameEmpty) {
        sellerName = 'Amazon';
        soldBy = 'Amazon';
        console.log(`✅ ${this._tag} Offer ${index} SBA ama seller yok — "Amazon" set edildi (frontend merge için)`);
      }
      
      // Prime price: eğer birden fazla fiyat bulunduysa, düşük olan prime fiyatı
      let primePrice = null;
      let primePriceText = null;
      if (primePriceData && primePriceData.price > 0 && price && primePriceData.price < price) {
        primePrice = primePriceData.price;
        primePriceText = primePriceData.text;
        console.log(`✅ ${this._tag} Offer ${index} Prime price: ${primePriceText} -> ${primePrice} (normal: ${priceText} -> ${price})`);
      }
      
      return {
        index: index,
        condition: condition,
        isNew: isNew, // Modal'da gösterilecek: New mi?
        isUsed: isUsed, // Modal'da gösterilecek: Used mi?
        price: price,
        priceText: priceText,
        primePrice: primePrice, // Prime member fiyatı (varsa, normal fiyattan düşük)
        primePriceText: primePriceText, // Prime member fiyat text
        shipsFrom: shipsFrom,
        soldBy: soldBy,
        sellerName: sellerName,
        // KRİTİK: Fulfillment Type (FBA/FBM/SBA)
        fulfillmentType: fulfillmentType,
        isFBA: isFBA,
        isFBM: isFBM,
        isSBA: isSBA,
        // KRİTİK: Satıcı değerlendirme bilgileri - Frontend modalda gösterilecek
        sellerRating: sellerRating, // Yıldız puanı (1-5)
        sellerRatingCount: sellerRatingCount, // Değerlendirme sayısı (örn: "77" veya "1234")
        positivePercentage: positivePercentage, // Pozitif yüzde (örn: 100, 98)
        // KRİTİK: Teslimat bilgileri - Ayrı field'lar olarak
        deliveryDate: deliveryDate, // Standard delivery date (geriye dönük uyumluluk)
        standardDeliveryDate: deliveryDate, // Standard delivery date
        expressDeliveryDate: expressDeliveryDate || null, // Express/Fast delivery date
        // KRİTİK: Gönderim fiyatları - Ayrı field'lar olarak
        shippingPrice: shippingPrice, // Standard shipping price (geriye dönük uyumluluk)
        standardShippingPrice: shippingPrice, // Standard shipping price
        expressShippingPrice: null, // Express shipping price (henüz çekilmiyor, ileride eklenebilir)
        isBuybox: !!isPinnedOffer, // Pinned offer = Buybox (modal'da "Buybox" etiketi için)
        cannotShip: cannotShip // Hedef ülkeye gönderim yapılamıyor flag'i
      };
    } catch (e) {
      console.error(`❌ ${this._tag} Seller data extraction hatası: ${e.message}`);
      return null;
    }
  }

  /**
   * Get seller information for a product using Playwright
   * @param {string} asin - Product ASIN
   * @param {string} sourceMarketplace - Source marketplace (amazon.com, amazon.co.uk, etc.)
   * @param {string} targetCountry - Target country code (optional)
   * @returns {Promise<{success: boolean, data: Object, error: string | null, status: number}>}
   */
  async getSellerInfo(asin, sourceMarketplace = 'amazon.com', targetCountry = null, opts = {}) {
    this._currentAsin = asin; // Tüm loglara ASIN eklenir
    let page = null;
    const usePool = !opts.sharedPage;
    try {
      console.log(`🎭 [Seller Playwright] Seller: ${asin} from ${sourceMarketplace} target=${targetCountry || 'default'} (${usePool ? 'pool' : 'shared'})`);
      if (opts.sharedPage) {
        page = opts.sharedPage;
      } else {
        const key = this.getContextKey(sourceMarketplace, targetCountry);
        console.log(`📦 [Seller Playwright] Page pool alınıyor: ${key}`);
        const pool = await this.getPagePool(sourceMarketplace, targetCountry);
        page = this.getNextPage(pool, key);
        console.log(`📦 [Seller Playwright] Sayfa alındı, AOD'a gidiliyor`);
      }
      // Marketplace domain mapping (pool/shared sayfa kullanılıyor — browser/context pool’da)
      const marketplaceDomain = {
        'amazon.com': 'www.amazon.com',
        'amazon.co.uk': 'www.amazon.co.uk',
        'amazon.de': 'www.amazon.de',
        'amazon.es': 'www.amazon.es',
        'amazon.it': 'www.amazon.it',
        'amazon.fr': 'www.amazon.fr',
        'amazon.co.jp': 'www.amazon.co.jp'
      };
      
      const baseDomain = marketplaceDomain[sourceMarketplace] || 'www.amazon.com';
      const baseUrl = `https://${baseDomain}`;
      
      // KRİTİK: Ülke/para seçimi sonrası doğrudan AOD URL (olp-opf-redir) — scroll yok, sadece #aod-filter-offer-count-string kadar
      const productUrl = `${baseUrl}/dp/${asin}`;
      const directAodUrl = `${baseUrl}/dp/${asin}/ref=olp-opf-redir?aod=1&ie=UTF8&condition=NEW&th=1`;
      
      // İlk navigasyon: ülke seçimi + ürün sayfası + AOD
      if (targetCountry) {
        const amazonCountryCode = this.convertToAmazonCountryCode(targetCountry);
        console.log(`🌍 ${this._tag} Ülke seçimi: ${targetCountry} -> ${amazonCountryCode}`);
        
        // Adım 1: Cookie enjeksiyonu — Amazon'un teslimat ülkesi cookie'lerini set et
        try {
          await page.context().addCookies([
            { name: 'lc-main', value: `en_${amazonCountryCode}`, domain: `.${baseDomain}`, path: '/' },
            { name: 'i18n-prfs', value: `rCFPRLLMR5T4T5eDBNMvdJPCJPMnKB7YqRCRKk3bGpZ4rR6E%2FJVc`, domain: `.${baseDomain}`, path: '/' }
          ]);
          console.log(`🍪 ${this._tag} UK cookie'leri enjekte edildi: lc-main=en_${amazonCountryCode}`);
        } catch (cookieErr) {
          console.warn(`⚠️ ${this._tag} Cookie enjeksiyonu hatası: ${cookieErr.message}`);
        }
        
        // Adım 2: Ürün sayfasına git
        console.log(`🔗 ${this._tag} Ürün sayfasına gidiliyor: ${productUrl}`);
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
        await this.safeWait(page, 2000);
        
        // Adım 3: Glow API ile teslimat ülkesini değiştir + popup fallback
        console.log(`🌍 ${this._tag} Glow API + popup ile ${amazonCountryCode} seçiliyor...`);
        // KRİTİK: Marketplace'e göre posta kodu — Glow API'ye zip code gönder
        const marketplacePostcodesForGlow = {
          'amazon.co.uk': 'N1 3QP',
          'amazon.de': '10115',
          'amazon.fr': '75001',
          'amazon.it': '00100',
          'amazon.es': '28001',
          'amazon.co.jp': '100-0001',
          'amazon.com': '10001',
          'amazon.ca': 'M5V 2T6'
        };
        const postcodeForGlow = marketplacePostcodesForGlow[sourceMarketplace] || '';
        console.log(`📮 ${this._tag} Glow API postcode: "${postcodeForGlow}" (${sourceMarketplace})`);
        
        const glowResult = await page.evaluate(async ({ countryCode, zipCode }) => {
          try {
            const formData = new URLSearchParams({
              deviceType: 'web', pageType: 'Detail', storeContext: 'generic',
              actionSource: 'glow', almBrandId: 'undefined',
              zipCode: zipCode, countryCode: countryCode, city: '', district: ''
            });
            const resp = await fetch('/portal-migration/hz/glow/address-change?actionSource=glow', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: formData.toString()
            });
            return { status: resp.status, ok: resp.ok };
          } catch (e) { return { error: e.message }; }
        }, { countryCode: amazonCountryCode, zipCode: postcodeForGlow }).catch(e => ({ error: e.message }));
        console.log(`📍 ${this._tag} Glow API: ${JSON.stringify(glowResult)}`);
        
        // Glow API sonrası sayfayı yenile (cookie'ler güncellendi)
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
        await this.safeWait(page, 2000);
        
        // Teslimat adresi doğrula
        const deliveryCheck = await page.evaluate(() => {
          const el = document.querySelector('#glow-ingress-line2, #contextualIngressPtLabel_deliveryShortLine');
          return el ? el.textContent.trim() : '';
        }).catch(() => '');
        console.log(`📍 ${this._tag} Teslimat: "${deliveryCheck}"`);
        
        // KRİTİK: Teslimat ülkesi doğru mu kontrol et
        // "London N1 3QP" gibi UK adres bilgileri de kabul edilmeli
        const deliveryLower = deliveryCheck.toLowerCase();
        const isDeliveryCorrect = deliveryLower.includes('united kingdom') || 
          deliveryLower.includes('uk') || 
          deliveryLower.includes(amazonCountryCode.toLowerCase()) ||
          deliveryLower.includes('london') ||
          deliveryLower.includes('england') ||
          deliveryLower.includes('scotland') ||
          deliveryLower.includes('wales') ||
          deliveryLower.includes('berlin') ||
          deliveryLower.includes('paris') ||
          deliveryLower.includes('madrid') ||
          deliveryLower.includes('roma') ||
          deliveryLower.includes('tokyo') ||
          /[a-z]{1,2}\d{1,2}\s*\d[a-z]{2}/i.test(deliveryCheck) || // UK postcode pattern (N1 3QP, SW1A 1AA vb.)
          /\d{5}/.test(deliveryCheck); // Kıta Avrupası/ABD/JP posta kodu pattern
        
        if (!isDeliveryCorrect) {
          console.log(`⚠️ ${this._tag} Hedef ülke seçili değil ("${deliveryCheck}"), popup ile deneniyor...`);
          const popupResult = await this.selectCountryAndCurrency(page, targetCountry, sourceMarketplace, productUrl);
          if (popupResult.success) {
            console.log(`✅ ${this._tag} Popup ile UK seçildi`);
            await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
            await this.safeWait(page, 2000);
          } else {
            console.warn(`⚠️ ${this._tag} Popup ile de UK seçilemedi: ${popupResult.error}`);
          }
          
          // Son doğrulama
          const finalCheck = await page.evaluate(() => {
            const el = document.querySelector('#glow-ingress-line2, #contextualIngressPtLabel_deliveryShortLine');
            return el ? el.textContent.trim() : '';
          }).catch(() => '');
          console.log(`📍 ${this._tag} Son teslimat doğrulama: "${finalCheck}"`);
        }
        
        // Adım 4: Ülke seçimi sonrası direkt AOD URL — See All Buying Options ürünlerinde buton tıklaması sidebar'ı boş açıyor
        // directAodUrl ile gidince sidebar düzgün yükleniyor (olp-opf-redir)
        console.log(`🔗 ${this._tag} directAodUrl ile AOD sayfasına gidiliyor: ${directAodUrl}`);
        await page.goto(directAodUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
        await this.safeWait(page, 2000);
      } else {
        // targetCountry yoksa direkt AOD URL'ye git
        console.log(`🔗 ${this._tag} AOD sayfasına gidiliyor (ülke seçimi yok): ${directAodUrl}`);
        await page.goto(directAodUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
        await this.safeWait(page, 2000);
      }
      
      // Buybox AOD pinned offer'dan gelecek — PDP atlandı
      let buyboxData = null;
      let isOnAodPage = true;

      // Captcha sayfası kontrolü (AOD linkinde çıkabiliyor)
      try {
        const urlNow = page.url();
        const bodyText = await page.textContent('body').catch(() => '');
        const isCaptchaPage = urlNow.includes('/errors/validateCaptcha') || bodyText.includes('Click the button below to continue shopping');
        if (isCaptchaPage) {
          console.warn(`⚠️ ${this._tag} Captcha sayfası tespit edildi (AOD), Continue shopping tıklanıyor...`);
          const btnSelectors = [
            'button[alt="Continue shopping"]',
            'form[action="/errors/validateCaptcha"] button[type="submit"]',
            'form[action="/errors/validateCaptcha"] button',
            'button:has-text("Continue shopping")',
            'button[type="submit"]'
          ];
          for (const sel of btnSelectors) {
            try {
              const btn = await page.$(sel).catch(() => null);
              if (btn) {
                await btn.click({ timeout: 30000 }).catch(() => btn.click({ force: true, timeout: 30000 }));
                await this.safeWait(page, 3000);
                break;
              }
            } catch (e) {
              continue;
            }
          }
        }
      } catch (e) {
        // Captcha kontrolü başarısız olsa bile akışa devam
      }
      
      // Sayfanın yüklenmesini bekle
      await this.safeWait(page, 3000);
      
      // KRİTİK: "Page Not Found" / 404 / köpek sayfası kontrolü
      // Amazon hedef pazarda ürün yoksa "Page Not Found" gösterir (köpek resimli sayfa)
      // Bu durum tespit edildiğinde erken dönüş yapılır — ürün hedef pazarda YOK
      try {
        const pageTitle = await page.title().catch(() => '');
        const bodyTextForCheck = await page.evaluate(() => {
          // Sadece ilk 2000 karakter — performans için
          return (document.body?.textContent || '').substring(0, 2000);
        }).catch(() => '');
        const currentUrlCheck = page.url();
        
        const isPageNotFound = 
          /page\s*not\s*found/i.test(pageTitle) ||
          /page\s*not\s*found/i.test(bodyTextForCheck) ||
          /sorry.*couldn.*find.*page/i.test(bodyTextForCheck) ||
          /looking\s+for\s+something/i.test(bodyTextForCheck) ||
          /the\s+web\s+address.*is\s+not\s+a\s+functioning\s+page/i.test(bodyTextForCheck) ||
          /we.*couldn.*find.*page/i.test(bodyTextForCheck) ||
          currentUrlCheck.includes('/404') ||
          currentUrlCheck.includes('/ref=cs_404');
        
        if (isPageNotFound) {
          console.log(`🚫 ${this._tag} PAGE NOT FOUND tespit edildi — ürün hedef pazarda mevcut değil`);
          console.log(`🚫 ${this._tag} Sayfa başlığı: "${pageTitle}"`);
          console.log(`🚫 ${this._tag} URL: ${currentUrlCheck}`);
          return {
            success: true,
            data: {
              asin: asin,
              sourceMarketplace: sourceMarketplace,
              targetCountry: targetCountry,
              totalSellers: 0,
              sellers: [],
              marketplace: 'source',
              buybox: null,
              hasNoBuybox: true,
              hasNoSellers: true,
              pageNotFound: true,
              unavailableMessage: 'Page Not Found - ürün hedef pazarda mevcut değil'
            },
            error: null,
            status: 200
          };
        }
      } catch (pageCheckErr) {
        console.warn(`⚠️ ${this._tag} Page Not Found kontrolü hatası: ${pageCheckErr.message}`);
      }

      if (!isOnAodPage) {
        console.log(`⏳ ${this._tag} Sayfa yüklendi, "New & Used" linki aranıyor...`);
      
      // "New & Used" linkini bul ve tıkla
      // KRİTİK: "Other sellers" linki de kabul edilmeli (bazı ürünlerde "New & Used" yerine "Other sellers" görünüyor)
      const newAndUsedSelectors = [
        'a#aod-ingress-link',
        '#dynamic-aod-ingress-box a',
        '#olpLinkWidget_feature_div a',
        'div.a-section.a-spacing-none.daodi-content', // KRİTİK: Tam class selector
        'div.daodi-content', // Yeni: div element
        'div[class*="daodi-content"]', // Yeni: class içinde daodi-content geçen div
        'div#dynamic-aod-ingress-box div.daodi-content', // Yeni: tam path
        'div#dynamic-aod-ingress-box div.a-section.a-spacing-none.daodi-content', // KRİTİK: Tam path ile class
        'a[href*="aod"]', // "Other sellers" linki de bu selector'da bulunabilir
        'a[href*="olp"]',
        'span.a-color-base:has-text("New & Used")',
        'a[href*="aod"] span.a-color-base'
      ];
      
      let newAndUsedLink = null;
      console.log(`🔍 ${this._tag} "New & Used" linki aranıyor (${newAndUsedSelectors.length} selector)...`);
      
      for (let i = 0; i < newAndUsedSelectors.length; i++) {
        const selector = newAndUsedSelectors[i];
        try {
          console.log(`🔍 ${this._tag} Selector ${i + 1}/${newAndUsedSelectors.length} deneniyor: ${selector}`);
          // Hem link hem de div elementlerini kontrol et
          const elements = await page.$$(selector).catch(() => []);
          console.log(`🔍 ${this._tag} ${selector} için ${elements.length} element bulundu`);
          
          for (let j = 0; j < elements.length; j++) {
            const element = elements[j];
            try {
              const text = await element.textContent().catch(() => '');
              const tagName = await element.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
              console.log(`🔍 ${this._tag} Element ${j + 1} (${tagName}) text: "${text.trim().substring(0, 50)}"`);
              
              // Text içinde "New & Used", "Other sellers", "from" veya "offers" geçiyorsa
              // KRİTİK: "Other sellers" linki de kabul edilmeli
              if (text.includes('New & Used') || text.includes('Other sellers') || text.includes('from') || text.includes('offers') || (text.includes('New') && text.includes('Used'))) {
                // Eğer div ise, parent veya child link'i bul
                if (tagName === 'div') {
                  // Div'in parent'ında link var mı?
                  const parentLink = await element.evaluateHandle(el => {
                    let current = el.parentElement;
                    let depth = 0;
                    while (current && current.tagName !== 'A' && current !== document.body && depth < 10) {
                      current = current.parentElement;
                      depth++;
                    }
                    return current && current.tagName === 'A' ? current : null;
                  }).catch(() => null);
                  
                  if (parentLink && parentLink.asElement()) {
                    newAndUsedLink = parentLink.asElement();
                    console.log(`✅ ${this._tag} "New & Used" link bulundu (div parent): ${selector}, text: "${text.trim().substring(0, 80)}"`);
                    break;
                  }
                  
                  // Div'in içinde link var mı?
                  const childLink = await element.$('a').catch(() => null);
                  if (childLink) {
                    newAndUsedLink = childLink;
                    console.log(`✅ ${this._tag} "New & Used" link bulundu (div child): ${selector}, text: "${text.trim().substring(0, 80)}"`);
                    break;
                  }
                  
                  // Div'e direkt tıklanabilir mi? (data-cursor-element-id varsa tıklanabilir)
                  const isClickable = await element.evaluate(el => {
                    const style = window.getComputedStyle(el);
                    const hasCursorId = el.getAttribute('data-cursor-element-id');
                    const hasClickHandler = el.onclick || el.getAttribute('onclick');
                    return style.cursor === 'pointer' || hasCursorId || hasClickHandler || el.closest('a');
                  }).catch(() => false);
                  
                  // Eğer div tıklanabilir görünüyorsa veya "New & Used" text'i içeriyorsa, direkt kullan
                  if (isClickable || text.includes('New & Used')) {
                    newAndUsedLink = element;
                    console.log(`✅ ${this._tag} "New & Used" div bulundu (tıklanabilir): ${selector}, text: "${text.trim().substring(0, 80)}"`);
                    break;
                  }
                } else {
                  // Direkt link
                  newAndUsedLink = element;
                  console.log(`✅ ${this._tag} "New & Used" link bulundu: ${selector}, text: "${text.trim().substring(0, 80)}"`);
                  break;
                }
              }
            } catch (e) {
              console.warn(`⚠️ ${this._tag} Element ${j + 1} kontrol hatası: ${e.message}`);
            }
          }
          if (newAndUsedLink) break;
        } catch (e) {
          console.warn(`⚠️ ${this._tag} Selector ${selector} hatası: ${e.message}`);
          continue;
        }
      }
      
      if (!newAndUsedLink) {
        // Alternatif: Direkt a#aod-ingress-link selector'ını dene
        console.log(`🔍 ${this._tag} Alternatif yöntem deneniyor: a#aod-ingress-link`);
        try {
          newAndUsedLink = await page.$('a#aod-ingress-link');
          if (newAndUsedLink) {
            const text = await newAndUsedLink.textContent().catch(() => '');
            console.log(`✅ ${this._tag} "New & Used" link bulundu (alternatif): "${text.trim()}"`);
          } else {
            console.warn(`⚠️ ${this._tag} a#aod-ingress-link bulunamadı`);
          }
        } catch (e) {
          console.warn(`⚠️ ${this._tag} Alternatif yöntem hatası: ${e.message}`);
        }
      }
      
      // Daha geniş bir arama yap - hem link hem div
      if (!newAndUsedLink) {
        console.log(`🔍 ${this._tag} Geniş arama yapılıyor: tüm elementler kontrol ediliyor...`);
        try {
          // Önce #dynamic-aod-ingress-box içindeki tüm elementleri kontrol et
          const aodBox = await page.$('#dynamic-aod-ingress-box').catch(() => null);
          if (aodBox) {
            console.log(`🔍 ${this._tag} #dynamic-aod-ingress-box bulundu, içindeki elementler kontrol ediliyor...`);
            const boxElements = await aodBox.$$('*').catch(() => []);
            for (const elem of boxElements) {
              try {
                const text = await elem.textContent().catch(() => '');
                const tagName = await elem.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
                if (text.includes('New & Used') || text.includes('from')) {
                  // Parent link'i bul
                  const parentLink = await elem.evaluateHandle(el => {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                      if (current.tagName === 'A') return current;
                      current = current.parentElement;
                      if (!current || current === document.body) break;
                    }
                    return null;
                  }).catch(() => null);
                  
                  if (parentLink && parentLink.asElement()) {
                    newAndUsedLink = parentLink.asElement();
                    console.log(`✅ ${this._tag} "New & Used" link bulundu (geniş arama - parent): "${text.trim().substring(0, 50)}"`);
                    break;
                  }
                }
              } catch (e) {
                // Devam et
              }
            }
          }
          
          // Hala bulunamadıysa, tüm linkleri kontrol et
          if (!newAndUsedLink) {
            const allLinks = await page.$$('a').catch(() => []);
            console.log(`🔍 ${this._tag} Toplam ${allLinks.length} link bulundu, kontrol ediliyor...`);
            
            for (let i = 0; i < Math.min(allLinks.length, 100); i++) {
              const link = allLinks[i];
              try {
                const text = await link.textContent().catch(() => '');
                const href = await link.getAttribute('href').catch(() => '');
                // KRİTİK: "Other sellers" linki de kabul edilmeli
                if ((text.includes('New & Used') || text.includes('Other sellers') || text.includes('from') || text.includes('offers') || href.includes('aod') || href.includes('olp')) && !newAndUsedLink) {
                  newAndUsedLink = link;
                  console.log(`✅ ${this._tag} "New & Used" / "Other sellers" link bulundu (geniş arama): "${text.trim().substring(0, 50)}"`);
                  break;
                }
              } catch (e) {
                // Devam et
              }
            }
          }
        } catch (e) {
          console.warn(`⚠️ ${this._tag} Geniş arama hatası: ${e.message}`);
        }
      }
      
      if (!newAndUsedLink) {
        console.warn(`⚠️ ${this._tag} "New & Used" / "Other sellers" link bulunamadı - Sayfa URL: ${page.url()}`);
        console.log(`✅ ${this._tag} Tek satıcılı ürün - Sadece buybox bilgileri döndürülüyor`);
        
        // KRİTİK: "New & Used" linki yoksa, bu ürün tek satıcılı demektir
        // Bu durumda sadece buybox bilgilerini döndür
        if (buyboxData) {
          return {
            success: true,
            data: {
              asin: asin,
              sourceMarketplace: sourceMarketplace,
              targetCountry: targetCountry,
              totalSellers: 1, // Tek satıcı (buybox)
              sellers: [buyboxData], // Sadece buybox satıcısı
              marketplace: 'source',
              buybox: buyboxData,
              singleSeller: true // Tek satıcı olduğunu belirt
            },
            error: null,
            status: 200
          };
        } else {
          // Buybox bilgisi de yoksa hata döndür
          return {
            success: false,
            data: null,
            error: 'New & Used / Other sellers link bulunamadı ve buybox bilgisi çekilemedi',
            status: 404
          };
        }
      }
      
      // "New & Used" linkine/div'ine tıkla
      // KRİTİK: Element görünür olmayabilir, href'den URL'yi al ve direkt git (daha güvenilir)
      console.log(`🖱️ ${this._tag} "New & Used" elementine tıklanıyor...`);
      
      // Önce href'den URL'yi al (en güvenilir yöntem - element görünür olmasa bile çalışır)
      let href = null;
      try {
        // Önce getAttribute ile dene (daha güvenilir)
        href = await newAndUsedLink.getAttribute('href').catch(() => null);
        
        // Eğer yoksa, evaluate ile dene
        if (!href) {
          href = await newAndUsedLink.evaluate(el => {
            // Önce kendi href'ini kontrol et
            if (el.href) return el.href;
            // Sonra parent <a> tag'ini kontrol et
            const parentLink = el.closest('a');
            if (parentLink && parentLink.href) return parentLink.href;
            // Son olarak href attribute'unu kontrol et
            if (el.getAttribute('href')) return el.getAttribute('href');
            return null;
          }).catch(() => null);
        }
        
        // Hala yoksa, page context'inde querySelector ile dene
        if (!href) {
          const selector = await newAndUsedLink.evaluate(el => {
            // Element için unique selector oluştur
            if (el.id) return `#${el.id}`;
            if (el.className) return `.${el.className.split(' ')[0]}`;
            return null;
          }).catch(() => null);
          
          if (selector) {
            href = await page.$eval(selector, el => {
              if (el.href) return el.href;
              const parentLink = el.closest('a');
              if (parentLink && parentLink.href) return parentLink.href;
              return el.getAttribute('href');
            }).catch(() => null);
          }
        }
        
        if (href) {
          // Relative URL ise absolute URL'ye çevir
          if (!href.startsWith('http')) {
            href = `https://www.amazon.com${href.startsWith('/') ? href : '/' + href}`;
          }
          console.log(`🔗 ${this._tag} href'den URL alındı: ${href}`);
          
          // KRİTİK: Hash URL (#dynamic-aod-ingress-box) ise, doğru AOD URL'yi oluştur
          if (href.includes('#dynamic-aod-ingress-box') || href.includes('ref=dp_product_quick_view')) {
            console.log(`🔗 ${this._tag} Hash URL tespit edildi, doğru AOD URL oluşturuluyor...`);
            try {
              // Önce link'e JavaScript ile tıkla (sidebar'ı açmak için)
              await newAndUsedLink.evaluate(el => {
                // Event trigger et
                const clickEvent = new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window
                });
                el.dispatchEvent(clickEvent);
              });
              console.log(`✅ ${this._tag} Hash URL için JavaScript event trigger edildi`);
              await this.safeWait(page, 2000); // Sidebar'ın açılması için bekle
              
              // Eğer sidebar hala açılmadıysa, doğru AOD URL'yi oluştur
              const currentUrl = page.url();
              // URL'den domain'i al (https://www.amazon.com veya https://www.amazon.co.uk gibi)
              const urlObj = new URL(currentUrl);
              const domain = `${urlObj.protocol}//${urlObj.host}`;
              // ASIN'den AOD URL'yi oluştur (domain + /gp/offer-listing/...)
              const aodUrl = `${domain}/gp/offer-listing/${asin}/ref=dp_olp_NEW_mbc?ie=UTF8&condition=NEW`;
              console.log(`🔗 ${this._tag} AOD URL oluşturuldu: ${aodUrl}`);
              await page.goto(aodUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
              console.log(`✅ ${this._tag} AOD sayfasına gidildi (hash URL fallback)`);
            } catch (jsError) {
              console.warn(`⚠️ ${this._tag} Hash URL işleme başarısız, normal click deneniyor: ${jsError.message}`);
              // Fallback: Normal click
              await newAndUsedLink.click({ timeout: 30000 });
            }
          } else {
            // Normal URL ise direkt git
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 18000 });
            console.log(`✅ ${this._tag} "New & Used" sayfasına direkt gidildi (href kullanılarak)`);
          }
        } else {
          throw new Error('href bulunamadı, normal click deneniyor');
        }
      } catch (hrefError) {
        console.warn(`⚠️ ${this._tag} href bulunamadı veya git başarısız, normal click deneniyor: ${hrefError.message}`);
        
        // href başarısız, normal click dene
        try {
          // Element tipini kontrol et
          const tagName = await newAndUsedLink.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
          console.log(`🔍 ${this._tag} Element tipi: ${tagName}`);
          
          await newAndUsedLink.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await this.safeWait(page, 1000);
          
          // Eğer div ise, önce parent link'i dene
          if (tagName === 'div') {
            try {
              // Div'in parent'ında link var mı kontrol et
              const parentLink = await newAndUsedLink.evaluateHandle(el => {
                let current = el.parentElement;
                let depth = 0;
                while (current && current.tagName !== 'A' && current !== document.body && depth < 10) {
                  current = current.parentElement;
                  depth++;
                }
                return current && current.tagName === 'A' ? current : null;
              }).catch(() => null);
              
              if (parentLink && parentLink.asElement()) {
                console.log(`🔍 ${this._tag} Div'in parent link'i bulundu, ona tıklanıyor...`);
                await parentLink.asElement().click({ timeout: 30000 });
                console.log(`✅ ${this._tag} Parent link'e tıklandı`);
              } else {
                // Div'e JavaScript ile tıkla
                await newAndUsedLink.evaluate(el => el.click());
                console.log(`✅ ${this._tag} Div'e JavaScript ile tıklandı`);
              }
            } catch (divClickError) {
              console.warn(`⚠️ ${this._tag} Div click başarısız, force click deneniyor: ${divClickError.message}`);
              await newAndUsedLink.click({ force: true, timeout: 30000 });
              console.log(`✅ ${this._tag} Div'e force click ile tıklandı`);
            }
          } else {
            // Normal link
            await newAndUsedLink.click({ timeout: 30000 });
            console.log(`✅ ${this._tag} "New & Used" linkine tıklandı`);
          }
        } catch (clickError) {
          console.warn(`⚠️ ${this._tag} Normal click başarısız, force click deneniyor: ${clickError.message}`);
          try {
            await newAndUsedLink.click({ force: true, timeout: 30000 });
            console.log(`✅ ${this._tag} "New & Used" elementine force click ile tıklandı`);
          } catch (forceClickError) {
            console.error(`❌ ${this._tag} Force click de başarısız: ${forceClickError.message}`);
            // Son çare: AOD URL'yi manuel oluştur
            const currentUrl = page.url();
            const baseUrl = currentUrl.split('?')[0];
            const aodUrl = `${baseUrl}?showAllOffers=1`;
            console.log(`🔗 ${this._tag} Son çare: AOD URL'ye gidiliyor: ${aodUrl}`);
            await page.goto(aodUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
            console.log(`✅ ${this._tag} AOD sayfasına gidildi (son çare)`);
          }
        }
      }
      
      // 3 saniye bekle (modal/sayfa açılması için)
      console.log(`⏳ ${this._tag} Modal/sayfa açılması bekleniyor (3 saniye)...`);
      await this.safeWait(page, 3000);
      }
      
      // AOD (All Offers Display) container'ını bekle - KRİTİK: Sidebar açılması için bekle
      console.log(`🛒 ${this._tag} Seller listesi container'ı bekleniyor (sidebar açılması için)...`);
      try {
        // Önce sidebar container'ını bekle
        await page.waitForSelector('#all-offers-display, #aod-container, #aod-offer-list, #aod-offer, #aod-pinned-offer', { timeout: 10000, state: 'visible' });
        console.log(`✅ ${this._tag} Seller listesi container bulundu`);
        
        // KRİTİK: Sidebar'ın tamamen yüklenmesi için ek bekleme
        await this.safeWait(page, 2000);
        
        // Sidebar içeriğinin yüklenmesini kontrol et
        const sidebarLoaded = await page.evaluate(() => {
          const pinnedOffer = document.querySelector('#aod-pinned-offer');
          const offerList = document.querySelector('#aod-offer-list');
          return !!(pinnedOffer || offerList);
        }).catch(() => false);
        
        if (sidebarLoaded) {
          console.log(`✅ ${this._tag} Sidebar içeriği yüklendi`);
        } else {
          console.warn(`⚠️ ${this._tag} Sidebar içeriği henüz yüklenmedi, ek bekleme (4s)...`);
          await this.safeWait(page, 4000);
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Seller listesi container bulunamadı, devam ediliyor: ${e.message}`);
      }
      await this.safeWait(page, 1000);
      
      // SEE ALL BUYING OPTIONS: #aod-pinned-offer > #aod-asin-block-asin > span.a-size-base = "No featured offers available"
      // → buybox yok, satıcılar sadece #aod-offer-list'ten çekilir. Detay: .cursor/rules/seller-playwright-see-all-buying-options.mdc
      let hasNoBuybox = false;
      try {
        const pinnedOfferEl = await page.$('#aod-pinned-offer').catch(() => null);
        if (pinnedOfferEl) {
          const pinnedText = await pinnedOfferEl.evaluate((el) => el.textContent || '').catch(() => '');
          if (/No featured offers available/i.test(pinnedText)) {
            hasNoBuybox = true;
            console.log(`ℹ️ ${this._tag} "No featured offers available" tespit edildi (erken) — buybox yok`);
          }
        }
      } catch (_) {}
      
      // KRİTİK: #aod-filter elementinde "no other sellers matching" mesajı var mı kontrol et
      // DİKKAT: Bu mesaj "buybox dışında başka satıcı yok" anlamına gelir!
      // Pinned offer (buybox) hala geçerli bir satıcı olabilir — sadece "other sellers" yok
      let hasNoSellers = false;
      let hasNoOtherSellers = false;
      try {
        const aodFilterEl = await page.$('#aod-filter').catch(() => null);
        if (aodFilterEl) {
          const filterText = await aodFilterEl.evaluate((el) => el.textContent || '').catch(() => '');
          if (/no\s+other\s+sellers\s+matching/i.test(filterText) || /currently.*unavailable/i.test(filterText)) {
            hasNoOtherSellers = true;
            console.log(`ℹ️ ${this._tag} #aod-filter: "No other sellers matching" mesajı tespit edildi`);
            
            // KRİTİK: Pinned offer'da geçerli bir satıcı var mı kontrol et
            // Eğer pinned offer varsa ve fiyat/satıcı bilgisi içeriyorsa, buybox satıcısı vardır
            if (!hasNoBuybox) {
              try {
                const pinnedOfferEl2 = await page.$('#aod-pinned-offer').catch(() => null);
                if (pinnedOfferEl2) {
                  const pinnedContent = await pinnedOfferEl2.evaluate((el) => {
                    const text = (el.textContent || '').trim();
                    // Fiyat var mı kontrol et (£, $, € sembolü)
                    const hasPrice = /[\$£€]\s*[\d,]+\.?\d*/.test(text);
                    // "Sold by" veya "Dispatches from" var mı
                    const hasSeller = /sold\s+by/i.test(text) || /dispatches\s+from/i.test(text) || /ships\s+from/i.test(text);
                    // "No featured offers available" değilse ve fiyat varsa geçerli
                    const isNoFeatured = /no\s+featured\s+offers\s+available/i.test(text);
                    // "Currently unavailable" kontrolü
                    const isUnavailable = /currently\s*unavailable/i.test(text) && /we\s+don.*t\s+know\s+when/i.test(text);
                    return { hasPrice, hasSeller, isNoFeatured, isUnavailable, textLen: text.length };
                  }).catch(() => ({ hasPrice: false, hasSeller: false, isNoFeatured: true, isUnavailable: false, textLen: 0 }));
                  
                  console.log(`🔍 ${this._tag} Pinned offer kontrolü: hasPrice=${pinnedContent.hasPrice}, hasSeller=${pinnedContent.hasSeller}, isNoFeatured=${pinnedContent.isNoFeatured}, isUnavailable=${pinnedContent.isUnavailable}, textLen=${pinnedContent.textLen}`);
                  
                  if (pinnedContent.hasPrice && !pinnedContent.isNoFeatured && !pinnedContent.isUnavailable) {
                    // Buybox satıcısı VAR — "no other sellers" sadece ek satıcı olmadığını belirtir
                    hasNoSellers = false;
                    console.log(`✅ ${this._tag} Pinned offer'da geçerli buybox satıcısı VAR — hasNoSellers=false (sadece diğer satıcılar yok)`);
                  } else if (pinnedContent.isUnavailable || pinnedContent.isNoFeatured) {
                    hasNoSellers = true;
                    console.log(`🚫 ${this._tag} Pinned offer geçersiz (unavailable/no featured) VE diğer satıcı yok — SIFIR satıcı`);
                  } else {
                    hasNoSellers = true;
                    console.log(`🚫 ${this._tag} Pinned offer'da fiyat bulunamadı VE diğer satıcı yok — SIFIR satıcı`);
                  }
                } else {
                  hasNoSellers = true;
                  console.log(`🚫 ${this._tag} Pinned offer elementi bulunamadı VE diğer satıcı yok — SIFIR satıcı`);
                }
              } catch (pinnedCheckErr) {
                hasNoSellers = true;
                console.warn(`⚠️ ${this._tag} Pinned offer kontrolü hatası: ${pinnedCheckErr.message} — SIFIR satıcı varsayılıyor`);
              }
            } else {
              // hasNoBuybox=true VE "no other sellers" → gerçekten hiç satıcı yok
              hasNoSellers = true;
              console.log(`🚫 ${this._tag} Buybox yok (No featured offers) VE diğer satıcı yok — SIFIR satıcı`);
            }
          }
        }
      } catch (_) {}
      
      // KRİTİK: Buybox alanında "Currently unavailable" kontrolü
      if (!hasNoSellers) {
        try {
          const buyboxEl = await page.$('#aod-pinned-offer, #aod-asin-block-asin').catch(() => null);
          if (buyboxEl) {
            const buyboxText = await buyboxEl.evaluate((el) => el.textContent || '').catch(() => '');
            if (/currently\s*unavailable/i.test(buyboxText) && /we\s+don.*t\s+know\s+when/i.test(buyboxText)) {
              hasNoSellers = true;
              console.log(`🚫 ${this._tag} Buybox: "Currently unavailable" tespit edildi — SIFIR satıcı`);
            }
          }
        } catch (_) {}
      }
      
      // Eğer hiç satıcı yoksa, direkt boş sonuç döndür — DOM parse etmeye gerek yok
      if (hasNoSellers) {
        console.log(`🚫 ${this._tag} Ürün satışta değil veya satıcı yok, boş sonuç döndürülüyor`);
        return {
          success: true,
          data: {
            asin: asin,
            sourceMarketplace: sourceMarketplace,
            targetCountry: targetCountry,
            totalSellers: 0,
            sellers: [],
            marketplace: 'source',
            buybox: null,
            hasNoBuybox: true,
            hasNoSellers: true,
            unavailableMessage: 'Currently unavailable - no sellers found'
          },
          error: null,
          status: 200
        };
      }
      
      // Toplam satıcı sayısını bul
      let totalSellers = 0;
      try {
        // Önce "#aod-filter-offer-count-string" elementinden sayıyı çıkar
        // "2 other options" formatından sayıyı çıkar
        const offerCountElement = await page.$('#aod-filter-offer-count-string').catch(() => null);
        if (offerCountElement) {
          const offerCountText = await offerCountElement.textContent().then(t => t.trim()).catch(() => '');
          if (offerCountText) {
            // "2 other options" veya "5 other options" formatından sayıyı çıkar
            const match = offerCountText.match(/(\d+)\s+other\s+options?/i);
            if (match) {
              const otherOptions = parseInt(match[1], 10);
              totalSellers = hasNoBuybox ? otherOptions : (otherOptions + 1); // +1 sadece pinned (buybox) varsa
              console.log(`✅ ${this._tag} Toplam satıcı sayısı (#aod-filter-offer-count-string): ${totalSellers}${hasNoBuybox ? ` (${otherOptions} other, buybox yok)` : ` (${otherOptions} other + 1 pinned)`}`);
            }
          }
        }
        
        // Eğer bulunamadıysa, "New & Used (6) from" formatından sayıyı çıkar
        if (!totalSellers || totalSellers === 0) {
          const newAndUsedText = await page.$eval('a#aod-ingress-link span.a-color-base', (el) => el.textContent.trim()).catch(() => '');
          const match = newAndUsedText.match(/\((\d+)\)/);
          if (match) {
            totalSellers = parseInt(match[1], 10);
            console.log(`✅ ${this._tag} Toplam satıcı sayısı (aod-ingress-link): ${totalSellers}`);
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} Toplam satıcı sayısı bulunamadı: ${e.message}`);
      }
      
      // KRİTİK: Pinned offer için "See more" linkine tıkla (eğer varsa)
      try {
        const seeMoreLink = await page.$('#aod-pinned-offer-show-more-link').catch(() => null);
        if (seeMoreLink) {
          console.log(`🔗 ${this._tag} "See more" linki bulundu, tıklanıyor...`);
          try {
            await seeMoreLink.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            await this.safeWait(page, 500);
            await seeMoreLink.click({ timeout: 10000 });
            console.log(`✅ ${this._tag} "See more" linkine tıklandı`);
            await this.safeWait(page, 2000); // Sidebar içeriğinin yüklenmesi için bekle
          } catch (clickError) {
            console.warn(`⚠️ ${this._tag} "See more" linkine tıklanamadı: ${clickError.message}`);
          }
        }
      } catch (e) {
        console.warn(`⚠️ ${this._tag} "See more" linki kontrol edilemedi: ${e.message}`);
      }
      
      // KRİTİK: Scroll ile tüm satıcıları yükle — Amazon lazy-load kullanır
      // DOM: #all-offers-display > ... > #all-offers-display-scroller > #aod-container > #aod-offer-list
      const targetCount = Math.min(totalSellers || 20, 30);
      try {
        // KRİTİK: Doğru scrollable container = #all-offers-display-scroller
        const scrollableInfo = await page.evaluate(() => {
          const scroller = document.querySelector('#all-offers-display-scroller');
          if (scroller) {
            return { found: true, id: 'all-offers-display-scroller', scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop };
          }
          // Fallback: overflow:auto/scroll olan herhangi bir AOD container
          const candidates = [
            document.querySelector('#all-offers-display'),
            document.querySelector('#aod-container'),
            document.querySelector('#aod-offer-list')?.parentElement
          ].filter(Boolean);
          for (const el of candidates) {
            if (el.scrollHeight > el.clientHeight + 50) {
              return { found: true, id: el.id || el.tagName, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, fallback: true };
            }
          }
          return { found: false };
        }).catch(() => ({ found: false }));
        
        console.log(`🔍 ${this._tag} AOD scrollable container:`, JSON.stringify(scrollableInfo));
        
        // KRİTİK: See All Buying Options — buton tıklanınca sidebar boş açılabiliyor, directAodUrl daha güvenilir
        let initialOfferCount = (await page.$$('#aod-offer-list #aod-offer').catch(() => [])).length;
        if (initialOfferCount === 0) initialOfferCount = (await page.$$('#aod-offer-list > div.a-section').catch(() => [])).length;
        const currentUrl = page.url();
        const needsDirectAodFallback = !scrollableInfo.found && initialOfferCount === 0 && !currentUrl.includes('olp-opf-redir');
        if (needsDirectAodFallback) {
          console.log(`🔄 ${this._tag} Sidebar boş (0 offer, scroll container yok) — directAodUrl ile yeniden deneniyor: ${directAodUrl}`);
          try {
            await page.goto(directAodUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
            await this.safeWait(page, 3000);
            await page.waitForSelector('#all-offers-display, #aod-container, #aod-offer-list, #aod-offer, #aod-pinned-offer', { timeout: 10000, state: 'visible' }).catch(() => null);
            await this.safeWait(page, 2500);
            // directAodUrl sonrası hasNoBuybox ve totalSellers yeniden hesapla
            try {
              const pinnedEl = await page.$('#aod-pinned-offer').catch(() => null);
              if (pinnedEl) {
                const txt = await pinnedEl.evaluate((el) => el.textContent || '').catch(() => '');
                if (/No featured offers available/i.test(txt)) {
                  hasNoBuybox = true;
                  console.log(`ℹ️ ${this._tag} "No featured offers available" (directAodUrl fallback sonrası)`);
                }
              }
            } catch (_) {}
            try {
              const countEl = await page.$('#aod-filter-offer-count-string').catch(() => null);
              if (countEl) {
                const txt = await countEl.textContent().then(t => t.trim()).catch(() => '');
                const m = txt.match(/(\d+)\s+other\s+options?/i);
                if (m) {
                  const other = parseInt(m[1], 10);
                  totalSellers = hasNoBuybox ? other : (other + 1);
                }
              }
            } catch (_) {}
          } catch (fallbackErr) {
            console.warn(`⚠️ ${this._tag} directAodUrl fallback hatası: ${fallbackErr.message}`);
          }
        }
        
        let prevCount = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = 30;
        let stableCount = 0;
        
        while (scrollAttempts < maxScrollAttempts) {
          // KRİTİK: Amazon tüm offer'ları tek div.a-section wrapper içine koyuyor
          // Gerçek offer'lar div#aod-offer olarak nested — bu yüzden #aod-offer-list #aod-offer kullan
          let currentOffers = await page.$$('#aod-offer-list #aod-offer').catch(() => []);
          if (currentOffers.length === 0) {
            currentOffers = await page.$$('#aod-offer-list > div.a-section').catch(() => []);
          }
          const currentCount = currentOffers.length;
          
          console.log(`🔄 ${this._tag} Scroll #${scrollAttempts}: ${currentCount} offer DOM'da (hedef: ${targetCount}, stable: ${stableCount})`);
          
          if (currentCount >= targetCount - 1) {
            console.log(`✅ ${this._tag} Hedef sayıya ulaşıldı: ${currentCount} offer (hedef: ${targetCount})`);
            break;
          }
          
          if (currentCount === prevCount) {
            stableCount++;
            if (stableCount >= 6) {
              console.log(`✅ ${this._tag} Scroll tamamlandı (yeni offer yüklenmiyor): ${currentCount} offer (hedef: ${targetCount})`);
              break;
            }
          } else {
            stableCount = 0;
          }
          
          prevCount = currentCount;
          scrollAttempts++;
          
          // KRİTİK: #all-offers-display-scroller'ı scroll et — bu gerçek scrollable element
          await page.evaluate(() => {
            // 1. ANA HEDEF: #all-offers-display-scroller (DOM'dan doğrulanmış)
            const scroller = document.querySelector('#all-offers-display-scroller');
            if (scroller) {
              scroller.scrollTop = scroller.scrollTop + 1500;
            }
            
            // 2. Fallback: diğer container'lar
            const fallbacks = [
              document.querySelector('#all-offers-display'),
              document.querySelector('#aod-container'),
              document.querySelector('#aod-offer-list')?.parentElement
            ].filter(Boolean);
            for (const c of fallbacks) {
              if (c.scrollHeight > c.clientHeight + 50) {
                c.scrollTop = c.scrollTop + 1500;
              }
            }
            
            // 3. Son offer'ı görünür yap (IntersectionObserver tetiklemek için)
            let offers = document.querySelectorAll('#aod-offer-list #aod-offer');
            if (offers.length === 0) offers = document.querySelectorAll('#aod-offer-list > div.a-section');
            if (offers.length > 0) {
              offers[offers.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
            }
          }).catch(() => {});
          
          await this.safeWait(page, 2000);
        }
        
        if (scrollAttempts >= maxScrollAttempts) {
          let finalCount = (await page.$$('#aod-offer-list #aod-offer').catch(() => [])).length;
          if (finalCount === 0) finalCount = (await page.$$('#aod-offer-list > div.a-section').catch(() => [])).length;
          console.log(`⚠️ ${this._tag} Scroll max denemeye ulaştı (${maxScrollAttempts}), ${finalCount} offer DOM'da`);
        }
      } catch (scrollErr) {
        console.warn(`⚠️ ${this._tag} Scroll hatası: ${scrollErr.message}`);
      }
      
      // KRİTİK: Scroll sonrası hala eksik satıcı varsa, Amazon AJAX pagination ile ek sayfaları yükle
      // Amazon AOD sidebar 10 offer/sayfa gösterir — geri kalanı AJAX ile yüklenir
      try {
        let currentDomCount = (await page.$$('#aod-offer-list #aod-offer').catch(() => [])).length;
        if (currentDomCount === 0) currentDomCount = (await page.$$('#aod-offer-list > div.a-section').catch(() => [])).length;
        console.log(`🔍 ${this._tag} Scroll sonrası DOM'da ${currentDomCount} offer, hedef: ${targetCount}`);
        
        if (currentDomCount < targetCount - 2) {
          console.log(`📡 ${this._tag} AJAX pagination ile ek satıcılar yükleniyor...`);
          let totalLoaded = 0;
          
          for (let pageno = 2; pageno <= 10; pageno++) {
            const extraCount = await page.evaluate(async ({ asin, pageno }) => {
              try {
                // Amazon AOD AJAX endpoint — sadece offer listesini döndürür
                const url = `/gp/aod/ajax?asin=${asin}&pc=dp&isonlyrenderofferlist=true&pageno=${pageno}&filters=%7B%22all%22%3Atrue%2C%22new%22%3Atrue%7D`;
                const resp = await fetch(url, { credentials: 'include' });
                if (!resp.ok) return { count: 0, error: `HTTP ${resp.status}` };
                const html = await resp.text();
                
                if (!html || html.trim().length < 50) return { count: 0, error: 'empty response' };
                
                // Response'u parse et
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                
                // Birden fazla selector dene — AJAX response yapısı farklı olabilir
                // KRİTİK: Amazon offer'ları div#aod-offer olarak nested koyuyor
                let newOffers = doc.querySelectorAll('#aod-offer-list #aod-offer');
                if (newOffers.length === 0) {
                  newOffers = doc.querySelectorAll('#aod-offer-list > div.a-section');
                }
                if (newOffers.length === 0) {
                  newOffers = doc.querySelectorAll('#aod-offer > div.a-section');
                }
                if (newOffers.length === 0) {
                  newOffers = doc.querySelectorAll('[id*="aod-offer"] > div.a-section');
                }
                if (newOffers.length === 0) {
                  // Son çare: herhangi bir .aod-offer veya id*=aod olan offer container
                  newOffers = doc.querySelectorAll('.aod-information-block');
                  if (newOffers.length > 0) {
                    // Her .aod-information-block'un parent section'ını al
                    const parents = new Set();
                    newOffers.forEach(el => {
                      const section = el.closest('div.a-section');
                      if (section) parents.add(section);
                    });
                    newOffers = Array.from(parents);
                  }
                }
                
                if (!newOffers || newOffers.length === 0) {
                  return { count: 0, htmlLen: html.length, error: 'no offers found in response' };
                }
                
                // Mevcut offer listesine ekle
                const offerList = document.querySelector('#aod-offer-list');
                if (offerList) {
                  const offerArray = Array.from(newOffers);
                  offerArray.forEach(offer => {
                    try {
                      offerList.appendChild(document.adoptNode(offer));
                    } catch (e) {
                      // adoptNode başarısız olursa innerHTML ile dene
                      const wrapper = document.createElement('div');
                      wrapper.className = 'a-section';
                      wrapper.innerHTML = offer.innerHTML;
                      offerList.appendChild(wrapper);
                    }
                  });
                  return { count: offerArray.length };
                }
                return { count: 0, error: 'no #aod-offer-list in page' };
              } catch (e) {
                return { count: -1, error: e.message };
              }
            }, { asin, pageno }).catch(e => ({ count: -1, error: e.message }));
            
            const loaded = extraCount?.count || 0;
            console.log(`📡 ${this._tag} AJAX sayfa ${pageno}: ${loaded} ek offer ${extraCount?.error ? `(hata: ${extraCount.error})` : 'yüklendi'}${extraCount?.htmlLen ? ` [html: ${extraCount.htmlLen} byte]` : ''}`);
            
            if (loaded <= 0) break;
            totalLoaded += loaded;
            await this.safeWait(page, 800);
          }
          
          let finalDomCount = (await page.$$('#aod-offer-list #aod-offer').catch(() => [])).length;
          if (finalDomCount === 0) finalDomCount = (await page.$$('#aod-offer-list > div.a-section').catch(() => [])).length;
          console.log(`✅ ${this._tag} AJAX pagination: ${totalLoaded} ek offer yüklendi, toplam DOM'da: ${finalDomCount}`);
        }
      } catch (ajaxErr) {
        console.warn(`⚠️ ${this._tag} AJAX pagination hatası: ${ajaxErr.message}`);
      }
      
      // Tüm seller offer'larını çek - KRİTİK: Sidebar'dan tüm bilgileri çek
      const sellers = [];
      try {
        const pinnedOffer = await page.$('#aod-pinned-offer').catch(() => null);
        // Pinned offer'ı çek — "No featured offers" yoksa (gerçek buybox varsa, hasNoBuybox yukarıda set edildi)
        if (!hasNoBuybox && pinnedOffer) {
          try {
            const pinnedSellerData = await this.extractSellerDataFromOffer(page, pinnedOffer, 0, true);
            if (pinnedSellerData) {
              sellers.push(pinnedSellerData);
              console.log(`✅ ${this._tag} Pinned offer sidebar'dan çekildi: ${pinnedSellerData.sellerName || pinnedSellerData.soldBy || 'N/A'}`);
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} Pinned offer çekilemedi: ${e.message}`);
          } finally {
            await pinnedOffer.dispose().catch(() => {});
          }
        }
        
        // KRİTİK: Amazon offer'ları tek div.a-section wrapper içine koyuyor
        // Gerçek offer'lar div#aod-offer olarak nested — her biri bir satıcı
        let offerElements = await page.$$('#aod-offer-list #aod-offer').catch(() => []);
        if (offerElements.length === 0) {
          // Fallback: eski selector (bazı marketplace'lerde farklı olabilir)
          offerElements = await page.$$('#aod-offer-list > div.a-section').catch(() => []);
        }
        if (offerElements.length === 0) {
          offerElements = await page.$$('#aod-offer-list > div').catch(() => []);
        }
        console.log(`🔍 ${this._tag} Offer elements bulundu: ${offerElements.length} (selector: ${offerElements.length > 0 ? '#aod-offer-list #aod-offer' : 'fallback'})`);
        // DOM'da ne kadar offer varsa hepsini işle, max 30
        const maxOther = Math.min(offerElements.length, 30);
        offerElements = offerElements.slice(0, maxOther);
        console.log(`🔍 ${this._tag} ${offerElements.length} diğer satıcı işlenecek (toplam hedef: ${totalSellers}, DOM'da: ${offerElements.length})`);
        
        for (let i = 0; i < offerElements.length; i++) {
          const offer = offerElements[i];
          try {
            // KRİTİK: Her offer için önce "More" butonuna tıkla (eğer varsa)
            // "More" butonu: a.a-link-normal.aod-delivery-morelink veya #aod-delivery-more-action > a
            try {
              // Offer içinde "More" butonunu bul
              const moreButton = await offer.$('a.a-link-normal.aod-delivery-morelink, #aod-delivery-more-action > a, a[aria-label*="More"]').catch(() => null);
              if (moreButton) {
                console.log(`🔗 ${this._tag} Seller ${i + 2} için "More" butonu bulundu, tıklanıyor...`);
                await moreButton.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
                await this.safeWait(page, 300);
                await moreButton.click({ timeout: 10000 }).catch(() => {});
                console.log(`✅ ${this._tag} Seller ${i + 2} için "More" butonuna tıklandı`);
                await this.safeWait(page, 1500); // Detayların yüklenmesi için bekle
              }
            } catch (moreError) {
              console.warn(`⚠️ ${this._tag} Seller ${i + 2} için "More" butonuna tıklanamadı: ${moreError.message}`);
            }
            
            // Her offer için sidebar'dan bilgileri çek (index'e göre selector'lar kullanılacak)
            await offer.click().catch(() => {});
            await this.safeWait(page, 500);
            const sellerData = await this.extractSellerDataFromOffer(page, offer, i + 1, false);
            if (sellerData) {
              sellers.push(sellerData);
              console.log(`✅ ${this._tag} Seller ${i + 2}/${offerElements.length + 1} sidebar'dan çekildi: ${sellerData.sellerName || sellerData.soldBy || 'N/A'}`);
            }
          } catch (e) {
            console.warn(`⚠️ ${this._tag} Seller ${i + 2} sidebar'dan çekilirken hata: ${e.message}`);
          } finally {
            await offer.dispose().catch(() => {});
          }
        }
        
        console.log(`✅ ${this._tag} Toplam ${sellers.length} seller offer çekildi`);
        
      } catch (e) {
        console.error(`❌ ${this._tag} Seller bilgileri çekilirken hata: ${e.message}`);
      }
      
      // KRİTİK: Aynı satıcı farklı condition'larda (New, Used) birden fazla offer olarak görünebilir
      // Amazon'da 1 satıcı gösteriliyorsa, envanterde de 1 satıcı gösterilmeli — sellerName/soldBy ile deduplicate
      const norm = (s) => {
        const name = (s?.sellerName || s?.soldBy || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
        return name || null;
      };
      const seen = new Map();
      const finalSellers = [];
      let unknownIdx = 0;
      for (const s of sellers) {
        let key = s.sellerId ? `id:${String(s.sellerId).trim()}` : norm(s);
        if (!key) key = `unknown_${unknownIdx++}`;
        if (seen.has(key)) continue;
        seen.set(key, true);
        finalSellers.push(s);
      }
      if (finalSellers.length < sellers.length) {
        console.log(`🔍 ${this._tag} Deduplication: ${sellers.length} → ${finalSellers.length} benzersiz satıcı`);
      }
      let finalTotalSellers = finalSellers.length;
      
      // KRİTİK: Total seller sayısını, döndürülen listenin uzunluğuna göre düzelt
      if (!finalTotalSellers || finalTotalSellers < finalSellers.length) {
        finalTotalSellers = finalSellers.length;
      }
      
      return {
        success: true,
        data: {
          asin: asin,
          sourceMarketplace: sourceMarketplace,
          targetCountry: targetCountry,
          totalSellers: finalTotalSellers,
          sellers: finalSellers,
          marketplace: 'source',
          buybox: hasNoBuybox ? null : (finalSellers.find(s => s.isBuybox) || null),
          hasNoBuybox: hasNoBuybox // "No featured offers available" — hiçbir satıcı buybox değil, ilk satıcı inventory'de gösterilecek
        },
        error: null,
        status: 200
      };

    } catch (error) {
      console.error(`❌ ${this._tag} Seller bilgileri çekilirken hata:`, error.message);
      console.error(`❌ Error stack:`, error.stack);
      return {
        success: false,
        data: null,
        error: error.message,
        status: 500
      };
    } finally {
      // Pool/shared kullanıldığında sayfa ve browser kapatılmaz — tekrar kullanılır
    }
  }

  /**
   * Get seller information for multiple ASINs in a single browser session (10 sekme paralel — vixify-playwright-service-batch mantığı).
   * Ülke + para birimi seçimi 1 kez yapılır, sonra ASIN değiştirerek AOD sayfaları gezilir.
   * @param {string[]} asins
   * @param {string} sourceMarketplace
   * @param {string|null} targetCountry
   * @returns {Promise<{success: boolean, data: Object|null, error: string|null, status: number}>}
   */
  async getSellerInfoBatch(asins, sourceMarketplace = 'amazon.com', targetCountry = null) {
    try {
      const asinList = Array.isArray(asins)
        ? asins.map(a => String(a || '').trim()).filter(Boolean)
        : [];

      if (asinList.length === 0) {
        return { success: false, data: null, error: 'ASIN list is required', status: 400 };
      }

      console.log(`🎭 [Seller Playwright] Batch: ${asinList.length} ASIN, 10 sekme paralel (browser bir kere)`);

      // 1) Browser bir kere, 2) Context + ülke bir kere, 3) 10 sekme pool
      await this.getBrowser();
      await this.getOrCreateContext(sourceMarketplace, targetCountry);
      const pages = await this.getPagePool(sourceMarketplace, targetCountry);
      const key = this.getContextKey(sourceMarketplace, targetCountry);

      const items = [];
      const batchSize = 10;

      for (let i = 0; i < asinList.length; i += batchSize) {
        const batch = asinList.slice(i, i + batchSize);
        const assignedPages = [];
        for (let j = 0; j < batch.length; j++) {
          assignedPages.push(this.getNextPage(pages, key));
        }
        console.log(`📦 [Seller Playwright] Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} ASIN paralel işleniyor (${i + 1}-${i + batch.length}/${asinList.length})`);
        const results = await Promise.all(
          batch.map((asin, j) =>
            this.getSellerInfo(asin, sourceMarketplace, targetCountry, { sharedPage: assignedPages[j] })
          )
        );
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          const asin = batch[j];
          if (r.success && r.data) {
            items.push({
              asin: r.data.asin || asin,
              sourceMarketplace: r.data.sourceMarketplace || sourceMarketplace,
              targetCountry: r.data.targetCountry != null ? r.data.targetCountry : targetCountry,
              totalSellers: r.data.totalSellers != null ? r.data.totalSellers : (r.data.sellers ? r.data.sellers.length : 0),
              sellers: r.data.sellers || [],
              buybox: r.data.buybox || null
            });
          } else {
            items.push({ asin, sourceMarketplace, targetCountry, totalSellers: 0, sellers: [], buybox: null });
          }
        }
        if (i + batchSize < asinList.length) {
          await new Promise(r => setTimeout(r, 800));
        }
      }

      console.log(`✅ [Seller Playwright] Batch tamamlandı: ${items.length} ürün, browser/sekmeler açık kalıyor`);
      return {
        success: true,
        data: { sourceMarketplace, targetCountry, totalItems: items.length, items },
        error: null,
        status: 200
      };
    } catch (error) {
      console.error(`❌ [Seller Playwright] Batch hata:`, error.message);
      return { success: false, data: null, error: error.message, status: 500 };
    }
  }
}

module.exports = new PlaywrightService();
