# Competitive positioning — analysis scope & the verification moat

> Konsolide rekabet notu. Amaç: farkımızı **dürüst ve iki-yönlü** kaydetmek (rakibin önde olduğu yeri de içeren),
> tek-taraflı "biz kazandık" değil. Rakip-iddiasına da kendi "honest verified" disiplinimizi uyguluyoruz.

## Flux.ai — simülasyon/analiz kapsamı (doğrulandı, Mart 2026 resmi launch blog'u + fetch)

**Desteklediği analizler:** klasik SPICE dörtlüsü — transient (`.tran`), AC sweep (`.ac`), operating point (`.op`), DC. Günlük-kullanım senaryolarıyla çerçevelenmiş: filtre/frekans-yanıtı (bode, −3dB, faz, rolloff), transient/timing (RC, step, debounce), gerilim/akım ripple.

**Motor + kütüphane:** "proven SPICE engine" (spesifik motor markası açıklanmıyor) + **340.000+ doğrulanmış model** kütüphanesi. İstek gelince Flux netlist'i kurar, kaynak/parametre yapılandırır, çalıştırır, açıklamalı sonuç döndürür.

**Model şeffaflığı (dürüst bir yön):** kullanıcı hangi modelin kullanıldığını sorabilir; Flux tam-üretici / davranışsal / ideal stand-in ayrımını söyler ("sayılara ne kadar güveneceğini bil"). Bu bir dürüstlük katmanı — ama **model-kaynağını** açıklar, sonucun **istatistiksel güvenilirliğini** değil.

**YOK (doğrulandı — kapsam listesinde yoklukla + açık felsefe beyanıyla):** parametrik sweep (`.step`), corner analizi, Monte-Carlo. Felsefeleri açıkça **tek-koşu / konuşmasal**: "tek seferde bir simülasyon, karmaşıklığı kademe kademe ekle." "Değer karşılaştırma" var ama otomatik `.step` süpürmesi değil — konuşma turu ("şimdi 470µF dene", yeniden koş).

## Flux'ın gerçek üstünlükleri (dürüstçe — biz eşleşmiyoruz)

- **340K doğrulanmış model kütüphanesi** — bizim TME-katalog + jenerik-model yaklaşımımızdan çok daha geniş, cilalı.
- **WebGL editör + konuşmasal UX** — olgun, hızlı, düşük-sürtünme.
- **$37M+ / ~6 yıl** olgunluk — özellik-parite yarışına girilmez (bkz. [PCB_BRIEF.md](../PCB_BRIEF.md) §2, "kimsenin yapamadığı önce, herkesin yaptığı sonra").

## Circuit Forge — farkımız: motor değil, motorun üstündeki **istatistiksel doğrulama katmanı**

|                   | Flux                    | Circuit Forge                                                                                                                         |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Temel analiz      | tran / ac / op / dc     | tran / ac / op / dc (+ .four/THD, .meas, .tf, .noise, .sens)                                                                                 |
| Çok-varyantlı     | ✗ (tek-koşu/konuşmasal) | **Monte-Carlo yield → robustness-tier (Wilson-95 alt sınır), tolerans-corner, ambient sıcaklık-corner**                               |
| Verdict semantiği | model-kaynağı açıklanır | **honest verified**: DRC-gate, spec-satisfaction, MC-gate (yalnız user-owned spread), scope-manifest (kontrol edilmeyeni de bildirir) |
| Kapalı döngü      | konuşmasal iterasyon    | **otomatik tasarla→sim→düzelt→doğrula** (AI+sim loop)                                                                                 |
| PCB               | —                       | **sim-verified → layout-constrained** (izler doğrulanmış akıma göre; bkz. PCB_BRIEF §4)                                               |

Onların simülasyonu "hızlı doğrulama" (tek nokta, nominal); bizimki **"1000 kart bassam kaçı çalışır"** — ki bu soru yalnızca MC/corner ile cevaplanır ve Flux onu sunmuyor.

## Kritik uyarı — bu bir baş-üstünlüğü, kalıcı duvar DEĞİL

- Flux'ın motoru zaten SPICE; `.step`/corner/MC motor seviyesinde muhtemelen **var**, sadece konuşmasal arayüzde **sunulmuyor** (ürün/felsefe seçimi, mimari duvar değil). İsteseler ekleyebilirler → memory: _"Flux ~12 ay arayla yakınsıyor."_
- İzole MC özelliği **kopyalanır**. Asıl moat = **entegre kapalı-döngü + honest-verified verdict + sim→layout zinciri** birlikte — tek istatistik özelliği değil. Duvarı orada tutmalıyız.

## Kendi iddiamıza da honest-verified disiplini

"1000 kart" iddiasını **modellediğimiz boyutlarda + açıklanmış tavanlarla** yaparız: robustness tolerans-kaynağı kadar iyi (catalog/user, disclosed); sıcaklık-corner **ambient-only** (self-heating/Tj modellenmiyor, manifest'te `gradation:'presence'` + ceiling ile bildiriliyor). Bu kesinlik zayıflık değil — tam da farkımız.

---

_Kaynak: Flux resmi launch blog'u (flux.ai, Mart 2026) — diğer-AI araştırması + doğrudan fetch. Kayıt tarihi: 18 Tem 2026. Circuit Forge tarafı: robustness-tier (Dalga-2), tolerans/ambient-corner (feat/verify-temp-corners), scope-manifest — hepsi main'de/PR'da._
