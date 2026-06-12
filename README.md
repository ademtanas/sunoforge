# 🎵 SunoForge — Suno AI Prompt Stüdyosu

Suno AI için ücretsiz, herkese açık, profesyonel müzik & vokal prompt oluşturucu. Türk müziği stilleri, 28 makam, bölüm bazlı vokal kontrolü, 3 çıktı formatı ve isteğe bağlı AI geliştirme içerir.

## Dosyalar

| Dosya | Görev |
|---|---|
| `index.html` | Uygulamanın tamamı (tek dosya, backend gerekmez) |
| `worker.js` | AI butonu için Cloudflare Worker proxy (anahtarınızı korur) |
| `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png` | PWA dosyaları — siteyi telefona uygulama olarak kurulabilir yapar |

## 1) Siteyi yayınlama (GitHub Pages — ücretsiz)

1. GitHub'da **Public** yeni repo açın (örn. `sunoforge`)
2. `index.html` ve `worker.js` dosyalarını yükleyin
3. **Settings → Pages → Branch: main, / (root) → Save**
4. Adresiniz: `https://KULLANICIADI.github.io/sunoforge/`

Bu adımla sitenin AI butonu hariç **her özelliği** çalışır.

## 2) AI butonunu açma (Cloudflare Workers — ücretsiz katman)

Kullanıcılar anahtar girmeden AI kullanır; istekler sizin Worker'ınız üzerinden, sizin Anthropic anahtarınızla gider. Anahtar tarayıcıya asla inmez.

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create Worker**
2. Worker adı verin (örn. `sunoforge-ai`), editöre `worker.js` içeriğini yapıştırın → **Deploy**
3. **Settings → Variables → Add secret** ile model anahtarlarını ekleyin (sadece eklediğiniz modeller aktif olur):
   - `GEMINI_API_KEY` → [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — **ÜCRETSİZ katman var, önerilen.** Gemini Flash ile günlük ücretsiz kota; size maliyet sıfır.
   - `ANTHROPIC_API_KEY` → console.anthropic.com (kullandıkça öde)
   - `OPENAI_API_KEY` → platform.openai.com (kullandıkça öde)
4. (Önerilen) Günlük IP limiti için: **Workers → KV → Create namespace** (`sunoforge-rl`) → Worker'ın **Settings → Bindings → KV Namespace** kısmından `RATELIMIT` adıyla bağlayın
5. Worker adresinizi kopyalayın: `https://sunoforge-ai.HESAP.workers.dev`
6. `index.html` içinde şu satırı bulun ve adresi yazın:
   ```js
   const AI_ENDPOINT='https://DEGISTIR.workers.dev/enhance';
   ```
   →
   ```js
   const AI_ENDPOINT='https://sunoforge-ai.HESAP.workers.dev/enhance';
   ```
7. Dosyayı repoya tekrar yükleyin. AI butonu otomatik görünür hale gelir.

### Maliyet kontrolü

- `worker.js` başındaki `DAILY_LIMIT = 20` → IP başına günlük AI hakkı. Düşürüp yükseltebilirsiniz.
- Yayına aldıktan sonra `ALLOWED_ORIGINS` listesine sadece kendi site adresinizi yazın; başka siteler Worker'ınızı kullanamasın.
- Anthropic konsolunda aylık harcama limiti (spend limit) belirleyin.

## 3) Özel alan adı (opsiyonel)

GitHub Pages → Settings → Pages → Custom domain kısmından kendi domaininizi bağlayabilirsiniz (ücretsiz SSL dahil).

## Özellikler

- Tür / alt tür / füzyon, dil, Türk müziği stilleri + 28 makam
- Dünya müzikleri: bölge → gelenek → enstrüman zinciri
- Tempo, aksak ölçüler (5/8, 7/8, 9/8 zeybek…), duygu, armoni
- Lead + eşlik + bas + perküsyon + 4 enstrümanlı özel orkestra
- Tam vokal kontrolü: tip, tarz, tını, efekt, kadın/erkek ses aralıkları
- Söz editörü: bölüm butonları, otomatik numaralama, bölüm algılama, bölüm bazlı vokal/lead ifadesi
- 3 format: Classic / Tag / Lyrics — canlı karakter sayacı, Optimize Et, Geri Al
- 7 hazır preset (Türkçe Duygusal Pop-Rap, Arabesk, Anadolu Rock…)
- Exclude Styles, 🎲 rastgele, geçmiş, JSON dışa/içe aktarma
- ✨ AI ile Geliştir (Claude, Worker üzerinden, kullanıcıya ücretsiz)

## Lisans

Serbestçe kullanın, geliştirin, paylaşın.

## 📱 Mobil uygulama (PWA)

Site GitHub Pages'te (HTTPS) yayınlanınca otomatik olarak **kurulabilir uygulama** olur:
- **Android (Chrome):** menü → "Ana ekrana ekle" / "Uygulamayı yükle"
- **iPhone (Safari):** Paylaş → "Ana Ekrana Ekle"

Çevrimdışı da çalışır (AI butonu hariç). Tüm dosyaları (`manifest.json`, `sw.js`, ikonlar) repoya yüklemeyi unutmayın.

## 🔄 Güncelleme yapısı (yeni Suno özellikleri)

Tüm seçenekler `index.html` içindeki tek bir `D` veri nesnesinde toplanmıştır. Yeni bir Suno özelliği/türü/enstrümanı çıktığında:
1. İlgili listeye satır ekleyin (örn. `D.genres`, `D.vocalFx`...)
2. `sw.js` içindeki `CACHE = "sunoforge-v1"` sürümünü artırın (`v2`) — kullanıcılar otomatik güncellemeyi alır
3. Repoya yükleyin, bitti.
