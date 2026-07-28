# Lever 2 — Akıllı Yerleşim (Placement) Planı

**Tarih:** 5 Temmuz 2026 · **Sürüm:** v2 (3 bağımsız adversarial denetimden geçti: kod-tutarlılık,
algoritma-şüpheci, anlaşılırlık — 22 bulgu işlendi) · **Durum:** ✅ **UYGULANDI** (Lever 2 sevk edildi)

> **Bu bir tarihsel plandır.** `packages/pcb-core/src/placement.ts` planın §4 boru hattını birebir
> uyguluyor, `placementGridMm` / `placementMarginMm` artık `FabProfile` alanları, ve `placer` seçeneği
> **üç** değer alıyor: `'grid' | 'auto' | 'rust'` — üçüncüsü, planda olmayan, süreç-dışı Rust motoru
> (`crates/pcb-placement-rs`). §6'daki dosya haritasında `← YENİ` diye işaretlenen
> `scripts/layout-sweep.mjs` ve ATmega fixture'ı **yapılmadı**; yield kapıları o yüzden bugün koşmuyor.
**Kapsam:** `packages/pcb-core` (+ ileride worker servisi) · **Önkoşul bilgi:** hiçbir şey.

---

## 0. Nasıl okunmalı + mini sözlük

Bölüm 1–2 problemi, hedefi ve **karar kutusunu** verir — onay için bu ikisi yeter. Bölüm 4 algoritmadır
(benzetme + örnekli). Bölüm 7 frontend sözleşmesi, Bölüm 9 kilometre taşları, Bölüm 10 dürüst riskler.

| Terim | Anlamı |
|---|---|
| **net** | elektriksel olarak birbirine bağlı olması gereken bacak kümesi ("R1'in 2. bacağı + LED'in anodu aynı net'te") |
| **via** | izin kartın öbür yüzüne geçmek için deldiği kaplamalı tünel — az olması iyidir |
| **courtyard** | parça gövdesi + montaj makinesinin güvenlik şeridi; iki courtyard üst üste binemez |
| **eval** | tscircuit kütüphanesini çalıştırıp devreden gerçek kart geometrisi (parça boyutları, pad konumları) üretmek |
| **pour** | GND'yi tek tek iz çekmek yerine boş alanları dolduran bakır havuzla dağıtmak |
| **DRC** | KiCad'in üretim kural denetimi — bizim "noter"imiz |
| **harness / gauntlet / golden** | gerçek-devre test koşucusu / zorlu devre sınavı / sabit-girdi-sabit-çıktı referans testi |
| **HPWL** | yerleşim kalitesinin ucuz ön-ölçüsü: her net'in kapladığı dikdörtgenin yarı-çevresi (mikrosaniyede hesaplanır) |

---

## 1. Problem nedir? (hiç bilmeyenler için)

Bir PCB üç adımda ortaya çıkar: **yerleşim** (parçalar nereye?) → **routing** (izler nasıl?) →
**doğrulama** (üretilebilir mi?). Bizde 2 ve 3 güçlü (freerouting + KiCad noter); zayıf halka **1**.

### Bugün: alfabetik dolap dizimi

Yerleşimimiz parçaları **kim kime bağlı hiç bakmadan** eşit aralıklı ızgaraya dizer. Benzetme: yeni
eve taşındın, eşyaları odalara **alfabetik** koydun. Tencere yatak odasında — ev "çalışır" ama her
yemekte koridorda 40 tur atarsın. O turlar PCB'de **uzun iz + via** demektir. Ölçülmüş kanıt:

| Kart | Bugünkü durum | Kaynak sorun |
|---|---|---|
| chaser-4017 (26 parça) | 106 iz, 16 via* | LED'ler 4017 çevresinde değil, rastgele grid'de |
| ATmega yoğun kartı (Faz 3) | **courtyard çakışması → FAIL** | grid, parça boyutu bilmiyor |

\* temsilî; kesin taban M3'te taahhütlü ölçümle sabitlenir (Bölüm 2 #3-4 o tabana göre değerlendirilir).

### Hedef: mutfağı ocağın etrafına kurmak

Mühendis nasıl yerleştirir: en çok bağlantılı parça (IC) **ortaya**, bağlı parçalar **çevresine**,
kablo çıkışları **kenara**. 555-blinker için fark:

```
   BUGÜN (grid, bağlantı-körü)              HEDEF (bağlantı-farkında)
  ┌────────────────────────┐             ┌────────────────────────┐
  │  R1      R2      C1    │             │ [V1]                   │   V1 = güç konnektörü → KENARDA
  │                        │             │  ║   R1  R2            │   ║ = kalın güç bağlantısı
  │  U1      R3      LED1  │             │  ║  ┌─U1─┐ C1          │   C1 = zamanlama kondansatörü,
  │                        │             │  ╚══│555 │             │        2-6 bacaklarının DİBİNDE
  │  V1      GND           │             │     └────┘─R3─►LED1    │   çıkış zinciri tek hat
  └────────────────────────┘             └────────────────────────┘
  izler çapraz, via'lı                    izler kısa, az via, "mühendis işi"
```

Lever 2 = bu sağduyuyu **algoritmaya** çevirmek: her devreye aynı, elle dokunmadan, milyon kombinasyonda.

---

## 2. Hedefler, ölçütler ve KARAR KUTUSU

| # | Ölçüt | Taban | Hedef |
|---|---|---|---|
| 1 | DRC-temiz oranı (30-devre taraması) | %97 | **≥ %97** (asla gerileme) |
| 2 | Kopuk net | 0 | **0** (Lever-1 garantisi korunur) |
| 3 | Toplam via (8'lik galeri) | M3'te ölçülür | **≥ %30 azalma** |
| 4 | Toplam iz uzunluğu (galeri) | M3'te ölçülür | **≥ %20 azalma** |
| 5 | Courtyard çakışması | ATmega'da VAR | **0 — ATmega gauntlet GEÇER** |
| 6 | Determinizm | var | **aynı girdi → aynı çıktı** (Bölüm 12 disipliniyle) |
| 7 | Yerleşim süresi (≤100 parça) | ~0 | **< 2 sn** (sabit adım sayısıyla; asla süre-kesmeli değil) |

**Vazgeçme kriteri:** kalibrasyon sonrası 3+4 tutmaz veya 1 gerilerse → grid'de kalınır, bu belgeye
"başarısız, sebep şu" yazılır. Yalancı iyileşme yok.

> ### 📦 KARAR KUTUSU (onay için bilmen gereken her şey)
> - **Süre:** M1 ~1 gün · M2 ~1–2 gün · M3 ~1 gün · M4 ~1 gün → **toplam ~4–5 iş günü** (benim tarafımda)
> - **Para:** 0 TL — **LLM API hiç gerekmez** (bakiye-yok kısıtında bugün başlanabilir); hesaplama yerel Docker
> - **Senin yapacağın:** şimdi bu planı onayla + M4'te ~15 dk görsel kontrol (galeri önce/sonra)
> - **En kötü senaryo:** DRC-oracle + grid-fallback sayesinde **bugünkü kalite** — kalite kumarı yok;
>   bedeli sadece süre (kart başına ~2× işlem, Bölüm 10'da dürüstçe hesaplı)

---

## 3. Neden hazır motor (RePlAce/OpenROAD) değil?

**RePlAce çip yerleştiricisidir, PCB yerleştiricisi değil.** İki taşıyıcı kanıt:
(a) Girdi modeli LEF/DEF'tir: standart hücre **satırları/site'ları** varsayar — PCB'de satır yoktur;
PCB'yi sahte çip gibi kodlamak başlı başına kırılgan bir çevirmen katmanı gerektirir.
(b) PCB'nin asıl zor kararlarını — courtyard'lı heterojen parçalar, 90° rotasyon, kenara konnektör,
decoupling'in IC dibinde olması — **hiç modellemez**; öneri sahibinin kendisi de "rotation'ı ve
legalization'ı kendiniz yazın" diyor. Yani zor kısım yine bizde kalır, karşılığında dev bir C++
bağımlılığı taşırız. Bizim ölçekte (5–100 parça) klasik yöntemler zaten milisaniyeler sürer; fark
hızda değil **modelleme sadakatindedir**.

---

## 4. Algoritma: 7 aşama

Tamamı `packages/pcb-core/src/placement.ts` içinde **saf fonksiyon** (dosya/Docker/network yok):
girdi = parçalar + bağlantılar + kart bilgisi, çıktı = her parçaya `{x, y, rotation}`. Jest ile
milisaniyede test edilir.

### 4.1 Veri toplama — boyutlar GERÇEK kaynaktan (iki-geçişli eval)

Akıllı yerleşim, her parçanın gerçek genişlik/yükseklik/pad konumlarını ister. Elle tablo YOK —
**tscircuit'in kendisinden**:

1. **Geçiş 1:** devre bugünkü grid ile bir kez eval edilir → tscircuit her parça için gerçek
   `pcb_component` (merkez, en, boy) + pad konumları + **courtyard çıktılarını** üretir (doğrulandı:
   eval çıktımızda `pcb_component` ve `pcb_courtyard_*` elemanları mevcut).
2. Bu gerçek boyutlarla yerleştirici çalışır (4.2–4.7).
3. **Geçiş 2:** hesaplanan koordinatlar **yeni `placementsById` opsiyonuyla** adapter'a verilir ve
   mm cinsinden **birebir** `pcbX/pcbY/pcbRotation` olarak yazılır.

> **Dürüst düzeltme (denetim bulgusu):** planın ilk taslağı "mevcut UiJson yolu aynen kullanılır"
> diyordu — **yanlıştı.** Mevcut yol şematik pozisyonlarını kartı dolduracak şekilde **ölçekleyip
> ortalar** (kompakt bir yerleşimi 2×'e büyütebilir) — decoupling'in "mm dibinde" hedefini ve FE
> round-trip garantisini bozar. Bu yüzden adapter'a **ölçeklemesiz, direkt-mm** modu eklenecek
> (M1 kapsamı); "adapter değişmez" iddiası geri çekildi.

### 4.2 Bağlantı grafiği + ağırlıklar — "hangi bağ ne kadar önemli?"

Düğün oturma planı benzetmesi: "gelinin annesi gelinin yanına" (ağırlık 10), "uzak kuzen herhangi
bir yere" (1).

| Bağlantı | Ağırlık | Neden |
|---|---|---|
| GND | ~0 | pour ile dağıtılıyor — kısaltılacak iz yok |
| Güç netleri (VCC...) | düşük | kalın/toleranslı (IPC-2221 zaten uygulanıyor) |
| Sinyal netleri | 1 | asıl kısaltılacaklar |
| **IC-dibi kritik pasifler** (decoupling **ve** zamanlama C'si) | yüksek | elektronik pratiği: bu parçalar ilgili IC bacağının mm mertebesinde dibinde olmalı |

**Bu satır elle etiket DEĞİL — türetilmiş kenar algoritması** (denetim bulgusu: VCC–GND arasındaki
kondansatörün netlist'te IC bacağına doğrudan kenarı yoktur; kenar **türetilir**):

1. Güç neti tespiti: kaynak/regülatör süren net (tipi `voltage_source` olan parçadan) ∪ isim deseni.
2. Decap adayı: güç neti ile GND arasındaki, değeri **≤ 1 µF** olan kondansatör (10 µF bulk elektrolitiği
   yanlışlıkla bacağa yapıştırmamak için eşik şart).
3. **Sahiplik ataması** (aynı VCC'yi 555 + 4017 paylaşıyorsa hangi IC'nin decap'i?): deterministik
   eşleme — her decap, aynı raydaki **henüz decap'siz** en yüksek bacak-sayılı IC'ye; eşitlikte
   designator sırası; varsa **UiJson şematik yakınlığı** birinci kırıcı (kullanıcı şemada C'yi hangi
   IC'nin yanına çizdiyse ona).
4. Zamanlama C'si zaten sinyal netiyle IC'ye **gerçek** kenar taşır (555'in 2-6 bacağı) — ekstra kural
   gerekmez, tabloya girmesinin sebebi ağırlığının 1'den yükseğe çekilmesi.

⚠ Dürüst risk (Bölüm 10'da da): çoklu-IC'de decap sahipliği **netlist'ten sezgisel tahmindir**;
yanlış atama DRC'ye ve via/iz metriklerine **görünmez** (kart yine temiz çıkar). v1 sınırı budur.

### 4.3 Tohum yerleşim — "önce ocak, sonra tencereler"

1. **Hub:** en yüksek ağırlıklı-bağlantılı parça (pratikte IC) → kart ortasına. **Eşitlik kırıcı:**
   designator sırası (determinizm).
2. Komşular hub çevresine halka halinde; halkadaki konum **trigonometrisiz**, hub'ın hangi bacak
   TARAFINA bağlıysa o kadran (sol bacaklara bağlı → sol) — Bölüm 12'deki determinizm disiplini gereği.
3. **Çoklu IC (somutlaştırıldı — denetim bulgusu):**
   - her parça, **toplam kenar ağırlığı en yüksek** olduğu hub'ın mahallesine; eşitlikte designator;
   - iki hub'a eşit bağlı "sınır parçaları" (chaser'daki CLK hattı gibi) iki hub'ı birleştiren doğru
     üzerine tohumlanır;
   - mahalleler, **aynı kuvvet simülasyonunun süper-düğüm versiyonuyla** yerleşir (mahalle = yarıçapı
     √(Σ courtyard alanı/π) olan tek balon, mahalleler-arası ağırlık = kesişen netlerin toplamı) —
     yeni algoritma icat edilmez, aynı kod bir üst seviyede koşar;
   - **hub'sız/simetrik devre** (H-köprü: 4 eş FET — hiçbir parçanın ağırlıklı derecesi medyanın
     2×'i değilse): halka tohumu ATLANIR, grid tohumundan doğrudan kuvvet fazına geçilir.
     H-köprü + 3-IC golden testleri M2'de yazılır (sonradan sürpriz değil).

### 4.4 Kuvvet-yönelimli iyileştirme + ARA rotasyon — "yaylar ve balonlar"

Her parça balon, her bağlantı **yay**: bağlılar çeker (ağırlık × mesafe), courtyard'ı yaklaşanlar
iter (çakışma **güçlü caydırılır** — kalanlar 4.6'da kesin temizlenir), kenara yaklaşan içeri itilir.
**Sabit 200 sönümlü adım** (çoğu kart dengeye yakınsar; yakınsamayan için güvenlik ağı devrede).

Sayısal mini-örnek — tek adımda R3:

```
R3 (20,10)'da. Bağları: U1.pin3 (15,10) ağırlık 1, LED1 (28,10) ağırlık 1.
Yay bileşkesi: (15-20)·1 + (28-20)·1 = +3  →  R3 sağa kayar → ~(21.5, 10):
iki komşusunun tam ortasına süzülüyor.
```

**Rotasyon force'tan SONRA değil, İÇİNDE** (denetim bulgusu: sona bırakılırsa dönen parçanın pad'leri
kayar, hesaplanan denge geçersizleşir): 80. ve 160. adımlarda **rotasyon taraması** araya girer, 200.
adımdan sonra seçilen açılarla **+50 adımlık kısa yeniden-denge** koşulur. Tarama sırası deterministik:
önce hub, sonra azalan ağırlıklı derece. Skor: her bacağın, bağlı netinin ağırlık merkezine uzaklığı —
**parçanın kendi pad'i merkez hesabına katılmaz** (öz-referans hilesi kapalı).

```
R3 rotasyon örneği (temsilî değerler; solda U1, sağda LED):
   0°:  pin1→U1 1.2mm + pin2→LED 1.4mm = 2.6mm   ✓ kazanan
 180°:  pin1→U1 4.8mm + pin2→LED 5.0mm = 9.8mm   ✗
```

26 parça × 4 açı × 3 tarama = mikrosaniyeler.

### 4.5 Konnektörler kenara

`connectorized` roldeki parçalar (güç header'ları — rol **elle etiket değil**, layoutability'nin
bugün de kullandığı parça-tipi kuralı: `voltage_source` → konnektör) kuvvet fazında en yakın kenara
hafif çekilir. Gerçek dünyada konnektör kartın ortasında olmaz.

### 4.6 Legalizasyon — "mıknatıslı ızgara, KANITLI bitiş"

(Denetim bulgusu: ilk taslaktaki "çakışma sıfırlanana dek yinele" sonsuz döngüye açıktı ve grid-snap
ile çelişiyordu. Yeniden tasarlandı:)

1. **Doluluk ön-kontrolü:** Σ courtyard alanı × paketleme katsayısı, kullanılabilir kart alanının
   **%75'ini aşıyorsa** kart **büyütülür** (kart boyutu zaten bizim ürettiğimiz değer) — asla sıkışan
   döngü yok; büyütme de raporlanır.
2. **Monoton yerleştirme (Abacus/Tetris tarzı):** parçalar courtyard alanına göre büyükten küçüğe;
   her çakışan parça **grid-katı adımlarla** (snap bozulmaz — yapısal olarak grid'de kalır) en düşük
   maliyetli yönde kaydırılır; her hamle kart-içi-margin'e **kenetlenir** (kart dışına itilme imkânsız);
   **sert tur limiti 4×n** — limitte hâlâ çakışma varsa kart büyütülüp bir kez tekrarlanır, yine
   olmazsa **yüksek sesli diagnostic + grid-fallback**. Sonlanma kanıtlı, asılı kalma yok.
   Unit test: bilerek küçük kartta 3 iç içe parça → ya büyümüş kartta yasal düzen ya diagnostic; asla hang.
3. **Kart boyutu politikası (denetim bulgusu — ilk taslakta hiç yoktu):** legalizasyon sonrası kart,
   courtyard sınır kutusu + routing payı + pour boşluğuna **küçültülür** (fab grid'ine yuvarlı, 20mm
   taban). Aptal-grid'e göre boyutlanmış devasa kartın kenarına konnektör sürükleyip güç izini
   UZATMA tuzağı böyle kapanır. (Kart-boyu değişiminin yerleşimi bozmadığı zaten kanıtlı: Lever-1'in
   `enlargeBoard` margin-retry'ı aynı şeyi yapıyor.)

### 4.7 Kabul testi — kademeli, bütçe-dürüst

(Denetim bulgusu: "grid'le karşılaştır" demek grid'i de ROUTE etmek demek — kart başına en kötü
12 freerouting + 12 DRC konteyneri. Kademeli politika:)

1. AUTO yerleşim route edilir. Tüm marjlarda DRC-temiz değilse → grid route edilir (bu bedel bugün
   de var — gerileme yok) → grid gönderilir, diagnostics'e yazılır.
2. AUTO temizse ve **HPWL** (mikrosaniyelik ön-ölçü) grid'e göre iyileştiyse → **grid hiç route
   edilmez**, auto kabul. Yalnız "temiz ama HPWL gerilemiş" nadir durumunda karşılaştırma route'u yapılır.
3. HPWL'in via-öngörücülüğü M3'te galeri-toplamı ölçümüyle bir kez istatistiksel doğrulanır
   (freerouting monoton değil — tekil kartta değil, toplamda değerlendirilir); doğrulandıktan sonra
   üretimde çifte-route yok, tam karşılaştırma yalnız harness'ta.

---

## 5. Sabitler ve KURALLAR "hardcode" mu? — Hayır; fark şu

**Sayısal sabitler** (ağırlıklar, adım sayısı, %75 doluluk eşiği): aday değerler taramada ölçülür,
kazanan **ölçüm raporuyla birlikte** commit'lenir. **Kalibrasyon seti ≠ sınav seti** (denetim
bulgusu): kalibrasyondan sonra final doğrulama **TAZE seed'li ikinci bir 30-devre taramasında**
yapılır — "kendi sınavına çalışmış" itirazı kapalı.

**Kurallar** (decap tespiti, connectorized-kenara): elle etiket değil, **her devreye aynı uygulanan
desen kuralları** — decap = netlist deseninden (güç-GND arası ≤1µF kondansatör, 4.2'deki deterministik
atama), connectorized = parça tipinden (`voltage_source`). İkisi de unit-testli.

Fab'a bağlı değerler (grid adımı, margin): **bugün adapter'da gömülü sabitler** (dürüst düzeltme —
ilk taslak "zaten config'te" diyordu, değil). M1'de `FabProfile`'a `placementGridMm` /
`placementMarginMm` olarak taşınacak — FE-snap/BE-legalizasyon tek-kaynak sözleşmesinin (7.3) önkoşulu.

---

## 6. Kod mimarisi

```
packages/pcb-core/src/placement.ts     ← YENİ: saf yerleştirici
packages/pcb-core/src/adapter.ts       ← DEĞİŞİR (dürüst düzeltme): placementsById direkt-mm modu
                                          (mevcut UiJson yolu ÖLÇEKLER — o yol elle-şematik için kalır)
packages/pcb-core/src/fab-profile.ts   ← placementGridMm / placementMarginMm alanları eklenir
packages/pcb-core/src/index.ts         ← layoutCircuit(circuit, { placer: 'auto' | 'grid' })
scripts/layout-sweep.mjs               ← YENİ (denetim bulgusu: 30-rastgele tarama repo'da YOKTU —
                                          Lever-1'de oturum-içi script'ti; seed'li olarak commit edilir)
scripts/layout-check.mjs               ← ATmega gauntlet devresi commit'li fixture olur (bugün
                                          gitignore'lu scratch'te — kalıcılaştırılır)
```

Akış:

```
CircuitJson ─► eval#1 (grid) ─► gerçek boyut/pad/courtyard ─► placement.ts ─► eval#2 (placementsById)
                                                                                   │
                                       freerouting + DRC oracle + HPWL kademesi ◄──┘
                                       (temiz değilse → grid'e düş, diagnostics'e yaz)
```

Kütüphane saf kalır (Docker enjekte). LLM API hiçbir aşamada gerekmez.

---

## 7. Frontend uyum sözleşmesi

İlke: **FE ile BE'nin algoritmaları değil, GEOMETRİ GERÇEĞİ ortak.**

1. **Tek pozisyon şeması:** `{id, x, y, rotation}` — mm, tek origin, tek y-yönü. Elle taşıma da
   "otomatik yerleştir" de aynı şemayı okur/yazar (direkt-mm modu sayesinde kayıpsız).
2. **Courtyard'ı BE üretir** (eval#1 çıktısındaki gerçek `pcb_courtyard_*`), FE çarpışma testini
   onunla yapar. Geometri iki kod tabanında iki kez tanımlanmaz — yoksa "FE izin verdi, DRC reddetti".
3. **Grid tek config:** `FabProfile.placementGridMm` hem FE snap'ini hem BE legalizasyonunu besler.
4. **Round-trip doğrulayıcı:** FE koordinatı → BE → geri, mm birebir mi? `verify-3d-alignment`
   deseninin FE-BE versiyonu CI'da. (Gövde-kayması dersi: konvansiyon varsayılmaz, doğrulanır.)

---

## 8. Test ve ölçüm planı

| Katman | Ne | Nasıl |
|---|---|---|
| Unit | yay/itme, rotasyon skoru, legalizasyon sonlanması (küçük-kart testi dahil), decap ataması (2-IC vakaları), determinizm | sentetik, milisaniye |
| Golden | 555-blinker düzeni; **H-köprü (hub'sız) + 3-IC** vakaları | sabit girdi → sabit çıktı |
| Entegrasyon | 8'lik galeri: grid vs auto (via/iz/DRC/HPWL tablosu) | gen-gallery raporu |
| Yield | `layout-sweep.mjs` (yeniden inşa, seed'li): DRC ≥ %97, kopuk 0; kalibrasyon + **taze-seed final** | M3 |
| Gauntlet | ATmega (commit'li fixture): çakışma 0 | M4 |
| Görsel | galeri GLB regen + verify-3d-alignment | founder gözü + 0.000mm kapısı |

---

## 9. Kilometre taşları (kapılı — kapı geçilmeden sonraki başlamaz)

| # | İş | Kapı | Süre |
|---|---|---|---|
| M1 | eval#1 boyut/courtyard çıkarımı; `placementsById` direkt-mm adapter modu; FabProfile grid/margin alanları; `layout-sweep.mjs` + ATmega fixture COMMIT; placement.ts iskeleti | boyutlar gerçek eval çıktısından doğrulandı; sweep koşuyor; testler yeşil | ~1 gün |
| M2 | tohum + kuvvet(+ara-rotasyon) + legalizasyon + kabul kademesi | golden'lar (H-köprü/3-IC dahil) + determinizm + sonlanma testleri yeşil | ~1–2 gün |
| M3 | kalibrasyon (sweep) + **taze-seed final** + metrik tablosu | via ≥%30↓, iz ≥%20↓, DRC ≥%97 | ~1 gün |
| M4 | ATmega gauntlet + galeri regen + görsel onay | çakışma 0; 8/8 DRC-temiz; **founder onayı (~15 dk)** | ~1 gün |
| M5 | (FE gelince) worker `placeComponents` + courtyard export + round-trip CI | kontrat testi yeşil | ayrı |

---

## 10. Riskler ve dürüst notlar

- **Yerel minimum:** kuvvet yöntemi bazı kartlarda kötüleşebilir → kart-başına oracle + grid-fallback
  = kalite tabanı korunur. **Fallback'in kapsamadığı iki şey ise şunlardır (açık göz):**
  1. *Decap yanlış-sahiplik* (4.2): kart yine DRC-temiz çıkar, metrikler bile iyileşebilir — hata
     hiçbir oracle'a görünmez. v1 sınırı; şematik-yakınlık kırıcısı riski azaltır, sıfırlamaz.
  2. *İyileşme hedefleri* (via/iz): fallback tabanı korur ama hedefi garanti etmez — hedefler M3
     ölçümüyle kanıtlanır, kanıtlanamazsa vazgeçme kriteri işler.
- **Maliyet dürüstlüğü:** iki-geçiş eval ~2× eval süresi (saniyeler) + kabul kademesine rağmen nadir
  durumlarda çifte route (dakikalar). Harness (M3/M4) Docker-yoğun ve en yavaş adım — takvime kondu.
- **Freerouting monoton değil:** tekil kartta via artabilir; hedefler galeri-toplamı üzerinden.
- **Kapsam dışı (v1):** çift yüzlü yerleşim; termal/EMC kuralları (güç kenara, kristal IC dibine);
  decap sahipliğinin elektriksel doğrulaması. Hepsi v2 adayı.

---

## 11. Founder SSS

**Elle/devreye-özel bir şey var mı?** Hayır. Sayısal sabitler ölçümle kalibre + raporla commit;
kurallar (decap/connectorized) her devreye aynı uygulanan, unit-testli desen kuralları (Bölüm 5).

**Milyon devrede ne olur?** Her devre aynı 7 aşamadan geçer; taban güvence fallback'te, iyileşme
kanıtı istatistiksel taramada. Sonsuz döngü/asılı kalma yapısal olarak imkânsız (4.6 sonlanma kanıtı).

**Kullanıcı FE'de elle taşırsa?** Pozisyonlar tek şemada; "otomatik yerleştir" istenirse motor doldurur,
istenmezse kullanıcının koyduğu mm'ler direkt-mm modundan **birebir** route edilir.

---

## 12. Determinizm eki (denetim bulgusu: "bit-bit aynı" ancak bu disiplinle mümkün)

- İzinli işlemler: `+ - * /` ve `Math.sqrt` (IEEE-754'te bit-kesin). **Trigonometri YASAK**
  (`sin/cos/atan2` V8 sürümleri arasında değişebilir — CI'daki ngspice-sürüm dersimizin JS karşılığı):
  rotasyonlar tam-sayı matrisleriyle `(x,y)→(-y,x)`, halka açıları pad-tarafı kadranlarından.
- Sıfır-mesafe çifti (üst üste tohum): epsilon-korumalı deterministik itme (0/0=NaN felaketi kapalı).
- Adım sayısı SABİT; süre-kesmeli iterasyon yasak (yoksa çıktı makine hızına bağlanır).
- CI'da Node major pinli; determinizm testi hem süreç-içi çift koşu hem Windows-dev/Linux-CI golden
  karşılaştırması (drift tarihsel olarak orada çıkıyor).
