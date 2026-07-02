# Circuit Forge — PCB Pipeline Brief (ön-araştırma + mimari karar dokümanı)

> Bu brief, PCB desteği konusunda bu oturumda varılan kararları, web-araştırması bulgularını ve doğrulanması gerekenleri tek yerde toplar. **Bu bir "şimdi inşa et" talimatı DEĞİL** — bir ön-araştırma/spec dokümanı. Runtime dondurması hâlâ geçerli (S4 deneyi + canlı N=4 tamamlanmadan multi-candidate/design-core yoluna dokunulmuyor); bu iş onlardan ve frontend v1'den SONRA sıraya girer.

---

## 1. Stratejik karar + ürün vizyonu (kayıt)

### 1.1 Vizyon (kullanıcının kendi ifadesiyle, hedef durum)
- Şemadan **otomatik PCB üretimi** (prompt → doğrulanmış devre → yerleşmiş+route'lanmış kart).
- **Katman desteği** (v1: 2 katman; 4-katman yolu açık tutulur — V10).
- Kullanıcı **elle müdahale edebilir** (bağlantı hint'leri, komponent taşıma/kilitleme, net-başına genişlik override) — tam manuel iz çizme değil, yönlendirilmiş müdahale (§4.1 merdiveni).
- **2D + 3D görünüm, en az Flux kadar detaylı**: ışık, yansıma, parlama, gerçek komponent gövdeleri, okunabilir serigrafî; 3D uzayda serbest gezinme (orbit/zoom/pan, kartı ters çevirme) — "3D programında model inceler gibi".
- Komponente **tıkla-bilgi-gör** (designator, değer, MPN).
- Çıktı: üretilebilir paket (.kicad_pcb + Gerber/drill + PnP + BOM) + **DRC-temiz damgası** — "verified" felsefesinin kart tarafı.

### 1.2 Editör merdiveni (netleştirilmiş karar — "editör yok" DEĞİL)
Şematik editörümüz **zaten var** (FRONTEND_BRIEF'in kalbi). PCB tarafında merdiven:
1. **Basamak 1 — Viewer (bu brief'in kapsamı):** 2D/3D salt-okunur görüntüleme + üretim paketi. Aşağıdaki pipeline.
2. **Basamak 2 — Constrained Layout Editor (Faz 4 vizyonu, §4.1):** kullanıcı taşır/kilitler/override eder → sistem **yeniden route + DRC + yeniden doğrular**. "Her düzenlemenin yeniden doğrulandığı kart" — Flux/KiCad'in yapamadığı, moat'ın editöre uzantısı. Tam editörün ~1/5 maliyeti.
3. **Basamak 3 — Manuel iz çizme (push-and-shove vb.):** yalnız **talep sinyali** gelirse ("layout'u elimle düzeltebilsem para veririm"). Gerekçe: KiCad ~30 yıl, Flux $37M+~6 yıl — özellik-parite yarışına girilmez; kimsenin yapamadığı önce, herkesin yaptığı sonra. O gün gelirse tscircuit editör-primitifleri üstüne inşa edilir, sıfırdan değil.

### 1.3 Yaklaşım: headless pipeline + canlı veri modeli
"Prompt → SPICE-doğrulanmış devre → **yerleşmiş + route'lanmış kart → üretilebilir çıktı**". Kullanıcı kartı KiCad'de açıp devam edebilir ya da doğrudan fab'a yükler. Canlı taraf (yerleşim, katmanlar, müdahale, anlık önizleme) **tscircuit veri modelinde** yaşar; son işlem (DRC/Gerber/GLB/render) **kicad-cli**'da (§2.3 rolü).

**PCB desteği 5 aşamaya ayrışır** (hepsi headless):
1. Footprint ataması (komponent → fiziksel kılıf)
2. Board outline + yerleşim
3. Routing (autoroute)
4. DRC
5. Çıktılar (Gerber, drill, pick-and-place, 3D)

Bunların **hiçbiri sıfırdan yazılmıyor** — aşağıdaki paket ekosistemi 1-5'in tamamını karşılıyor; bizim yazdığımız şey adaptör + tutkal + moat katmanı.

---

## 2. 2026 ekosistem bulguları (web-araştırması — V-görevleriyle doğrulanacak)

### 2.1 tscircuit — ana aday (TS-native, çekirdeğe import edilebilir)
- Açık kaynak React/TypeScript elektronik toolchain'i; **MIT lisanslı** → çekirdeğe (eda-core/worker) doğrudan import edilebilir, lisans bulaşması yok.
- **Monolitik değil, modüler paket ailesi.** Ortada kendi "Circuit JSON" ara formatları var (bizimkiyle isim benzerliği tesadüf ama kavramsal kuzen); etrafında bağımsız converter'lar:
  - `circuit-json-to-gerber` — Gerber üretimi
  - `dsn-converter` (0.0.91 — rapor doğruladı) — freerouting köprüsü (DSN yaz → SES geri oku)
  - **`circuit-json-to-kicad`** (0.0.156, MIT, lisans dosyası mevcut — rapor doğruladı) — **.kicad_pcb menteşesi bu** (PoC'ta 24.7KB kart yazdı). Eski `kicad-converter` (Tem 2025) / `kicad-mod-converter` (Tem 2024) BAYAT — kullanma
  - `@tscircuit/footprinter` — "footprinter string" sistemi: `"0402"` gibi bir string → pad geometrisi otomatik; parametrik footprint kütüphanesi
  - Kendi autorouter'ları — "4-katmanlı kartlarda saniye-altı, yerelde koşar, LLM-compatible tweaking" iddiası (autorouting.com); freerouting'i de sponsor ediyorlar
  - `pcb-viewer` / 3D viewer React bileşenleri — frontend'in salt-okunur board önizlemesi için hazır
  - Yan not: `ngspice-spice-engine` (WASM ngspice) + `circuit-json-to-spice` paketleri de var — bizim sim tarafımız için gerekmiyor ama ekosistemin sim-farkındalığı adaptörü kolaylaştırır.
- **Net-başına trace width ayarlanabiliyor**; `PcbGroup.autorouter_configuration.trace_clearance` gibi kısıt alanları şemada mevcut → moat katmanımız (aşağıda §4) doğrudan buraya oturur.
- Topluluk: ~2.1k yıldız, ~304 repo, ~397 katkıcı (2026 başı itibarıyla).
- **Dürüst sınırlar:** (a) ERC/DRC henüz olgun değil (Mart 2026 topluluk değerlendirmesi açıkça söylüyor) → son imzayı KiCad'e attırıyoruz; (b) kalite tavanı 2-4 katman standart kartlar — RF/high-speed/empedans-kontrollü işler kapsam dışı (bizim kullanıcı kitlesi için sorun değil); (c) genç ekosistem — paket adları/API'ler hareketli, pin'lenmiş versiyonlarla çalış.

### 2.2 freerouting
**GPLv3** Java autorouter; Specctra DSN alır, SES döner; resmi imaj `ghcr.io/freerouting/freerouting`, CLI `--gui.enabled=false -de in.dsn -do out.ses`. tscircuit autorouter'ının kalite alternatifi/yedeği. **GPLv3 → süreç sınırında tut** (ayrı container, dosya alışverişi; asla link etme; FSF FAQ ile teyit — çıktı dosyaları bulaşmasız). **Sürüm pin: tam `2.2.4`** — iki bağımsız doğrulanmış sebep: (a) v2.x'te v1.9'a göre kalite regresyonu var (Discussion #508: v1.9'un tam route'ladığı kartlarda v2.1 kopuk bırakabiliyor; topluluk "en stabil v1.9" diyor) → **kalite kıyasına v1.9.0 jar'ını da kat**; (b) **2.2.3, KiCad 10'dan export edilen DSN'lerde layer-init bug'ıyla kırık** (Issue #676; 2.2.4'te düzeltildi + regresyon testi eklendi) — bizim noter KiCad 10 olduğu için 2.2.3 bizim hatta ÇALIŞMAZ. API servis modu (:37864) kullanılacaksa: auth default KAPALI → izole network şart (v2.2.1 auth-bypass fix geçmişi).

### 2.3 kicad-cli — rolü: **PCB'nin ngspice'ı** (kullanıcı hiç görmez)
tscircuit'in rakibi DEĞİL — hattın sonundaki işlem fabrikası. Nasıl sim'de deck'i biz üretip koşturmayı 30 yıllık ngspice'a yaptırıyorsak, kartta tasarımı tscircuit'le üretip son işlemleri kicad-cli'ya yaptırıyoruz. Docker'da koşar (**ngspice worker kalıbının birebir aynısı**, bir container daha), dosya alır dosya verir. GPL süreç-sınırında sorun değil. Dört somut işi:
1. **DRC noterliği** — tscircuit'in kural denetimi genç; `kicad-cli pcb drc` (ihlalde exit-code, `--format json`) fab'a gitmeden clearance/kısa-devre/bağlanmamış-net yakalar. "Verified" felsefesinin kart karşılığı: **DRC-temiz damgası.** İmaj: **`kicad/kicad:10.0-full`** — zone refill (`--refill-zones --save-board`) yalnız KiCad 10 CLI'da var (resmi 10.0 docs ile doğrulandı; 9 bayat/boş fill'i sessizce plot eder), `-full` şart çünkü plain tag'de 3D model paketi (kicad-packages3D) yok.
2. **Üretim dosyaları** — Gerber/drill'i fabrikaların on yıllardır beslendiği referans üreticiden almak.
3. **GLB + gerçek 3D modeller** — Flux-seviyesi görselin "NE render ediliyor" yarısı (§2.6): KiCad kütüphanesinin üretici-kalitesi komponent gövdeleri GLB'ye gömülü gelir.
4. **`pcb render`** — sunucuda raytraced PNG (thumbnail/rapor, frontend maliyeti sıfır).

Tek menteşe: **circuit-json → .kicad_pcb converter'ı** (tscircuit'te var; sadakati V-görevlerinde test edilir). kicad-cli atlanırsa 1-4 kaybedilir; yerine ya kendi model kütüphanesi kurulur (haftalar) ya jenerik kutularla yaşanır.

### 2.4 Ticari kalite-yükseltme seçenekleri (session-1 rakip araştırmasından)
- **DeepPCB** — routing API, ~$0.50/dk; freerouting yetersiz kalırsa takılabilir (cookbook G2/G3 zaten bunu planlıyordu).
- **Quilter** — fizik-tabanlı layout, ITAR; partner-kademesi aday. Not: Quilter fizik yapıyor ama **kapalı-döngü sim doğrulaması yok** — bizim zincir (aşağıda) hâlâ benzersiz.

### 2.5 Flux nasıl yapıyor (soruya cevap)
Kendi in-house, tarayıcı-içi WebGL editörü — hazır paket kullanmadılar, parayı bastılar. 3D görünümlerindeki gerçekçilik iki şeyden geliyor: (a) gerçek üretici 3D modelleri (STEP→web formatı) + PBR materyaller (soldermask parlaması, altın pad metalik yansıması, ortam ışığı), (b) editörle aynı sahnede koşan custom WebGL motoru. (a)'yı biz de alırız (aşağıda), (b)'ye ihtiyacımız yok — biz editör değil viewer yapıyoruz. Kopyalanmayacak yol; bizim farkımız doğrulanmış-tasarım → üretilebilir-çıktı hattı.

### 2.6 3D görselleştirme ekosistemi (yeni araştırma — Flux-seviyesi görsel için)
- **kicad-cli 3D export (kilit bulgu):** `kicad-cli pcb export glb` — kartı **GLB (binary glTF)** olarak veriyor; `--include-tracks --include-zones --include-pads --include-silkscreen --include-soldermask --subst-models` bayraklarıyla bakır izler, zone'lar, pad'ler, serigrafî ve soldermask geometri olarak dahil. GLB = Three.js'in **native** yüklediği format (GLTFLoader) — dönüşüm yok, FreeCAD-türü hack'ler yok. Ayrıca `pcb export step/stl/ply/vrml/brep` de var.
- **kicad-cli pcb render (bonus):** sunucu tarafında **raytraced PNG/JPEG** üretiyor — açı, zoom, perspektif, ışık renkleri, kalite preset'leri parametreyle. Thumbnail'ler, proje kartları, og-image'lar, PDF raporlar için frontend maliyeti SIFIR foto-gerçekçi render.
- **Komponent 3D modelleri:** KiCad'in kendi kütüphanesi standart footprint'lerin (0402/0603/0805, SOT-23, SOIC, DIP, TO-92, USB-C, buton, pin header...) 3D modellerini içeriyor — bizim v1 küratörlü paletimiz tamamen standart kılıflar olduğu için GLB export'a **üretici-kalitesinde modeller bedavaya** biniyor. Palette olmayan parçalar için: SnapMagic/TraceParts STEP (cookbook C3).
- **tscircuit 3D viewer:** `@tscircuit/3d-viewer` (MIT, aktif) — `<CadViewer circuitJson={...} />` ile circuit-json'dan **doğrudan** interaktif 3D; komponent modelleri `jscad-electronics` (parametrik, React/JSCAD ile kod-üretimli; SOT-23, TSSOP vb.) + `cadModel` prop'uyla harici obj/stl/gltf/step URL. Vanilla-THREE'ye geçiş sürüyor (v01 branch). Dürüst sınır: modeller parametrik-jenerik → hızlı/anlık ama **Flux-seviyesi foto-gerçekçi değil**; genç kod tabanı (topluluk thread'lerinde ölçekleme/React-19 pürüzleri).
- **Frontend render stack:** Three.js + react-three-fiber + drei (`Environment` HDRI ortam ışığı, `ContactShadows`, `MeshPhysicalMaterial`) → GLB'yi Flux-kalitesinde gösterir. **Rust GEREKMİYOR** — Rust/wgpu, dev sahneli interaktif *editörlerin* alanı; salt-okunur viewer için Three.js + GLB fazlasıyla yeter. WebGPU opsiyonel gelecek, bugün karar değil.

---

## 3. Önerilen mimari (hibrit)

```
CircuitJson (+ yeni `footprint` alanı per component)
   │  [ADAPTÖR — bizim yazdığımız ana parça]
   ▼
tscircuit circuit-json  ──►  footprinter (kılıf/pad geometrisi)
   │
   ├─► autoroute: tscircuit yerel autorouter  (varsayılan)
   │              └─ yedek/kalite: DSN → freerouting (Docker) → SES geri oku
   │              └─ premium: DeepPCB API (sonra)
   ▼
route'lanmış circuit-json
   ├─► circuit-json-to-gerber  ─► Gerber/drill/PnP
   ├─► KiCad export            ─► .kicad_pcb (kullanıcı KiCad'de devam edebilir)
   ▼
kicad-cli (Docker, **kicad/kicad:10.0-full**)  ─►  DRC (`--refill-zones`, exit-code, json) + final Gerber + **GLB (3D)** + **raytraced PNG**   [NOTER — son imza]
   ▼
çıktılar: .kicad_pcb + gerber.zip + PnP CSV + BOM + DRC raporu + board.glb + render.png
```

**API/worker entegrasyonu:** endpoint-cookbook **Reçete B (async LRO)** birebir — `POST /versions/:versionId/layout` → `LayoutJob` (Prisma; `RouteJob`'ın genellemesi, cookbook G2/G3'ü kapsar) → BullMQ 'layout' queue → worker consumer → poll `GET /layout-jobs/:id`. Worker'a iki yeni Docker imajı: freerouting-jre (opsiyonel), kicad-cli.

**Footprint verisi v1:** dış API gerekmez — paletteki ~20 komponent tipi için elle küratörlü eşleme (R/C → 0402/0603/0805/1206, diyot → SOD-123, BJT → SOT-23/TO-92, op-amp → SOIC-8/DIP-8, ...) + footprinter string'leri. Sonra SnapMagic (cookbook C1) ile genişler. Kullanıcı `component.properties.footprint` ile override edebilir.

**Frontend — 2D/3D board görselleştirme (iki kademeli, §2.6 bulgularına dayanır):**

Flux'ın Schematic/Code/PCB moduna karşılık bizde: **Schematic** (mevcut FRONTEND_BRIEF editörü — düzenlenebilir) / **Code** (public API + MCP, zaten farkımız) / **PCB 2D-3D** (ilk sürümde salt-okunur; Faz 4'te kısıt-editörüne evrilir, §4.1):

- **2D:** tscircuit `pcb-viewer` (React, MIT) route'lanmış circuit-json'dan interaktif üst/alt görünüm; alternatif/tamamlayıcı: kicad-cli `pcb export svg`.
- **3D Kademe-1 — anlık interaktif (tasarım sırasında):** `@tscircuit/3d-viewer` circuit-json'dan direkt, backend'siz, saniyeler içinde; parametrik jscad modeller. Hover/click ile komponent bilgisi (designator, değer, MPN) native. İterasyon/önizleme için — "yeterince iyi", foto-gerçekçi değil.
- **3D Kademe-2 — foto-gerçekçi "vitrin" (finalize layout'ta):** worker'da `kicad-cli pcb export glb` (track/zone/pad/silkscreen/soldermask + KiCad kütüphane 3D modelleri dahil) → GLB Asset olarak S3'e → frontend'de **react-three-fiber + drei** (Environment HDRI, ContactShadows, PhysicalMaterial) ile Flux-kalitesi döndürülebilir 3D. Komponent-tıkla-bilgi-gör: GLB'deki node adları → refdes → bizim BOM verisi eşlemesi (raycast; V7'de doğrulanacak). Thumbnail/rapor için ek olarak `kicad-cli pcb render` raytraced PNG (frontend maliyeti sıfır).
- **Rust yok, custom WebGL motoru yok** — Three.js + GLB bu işi kapatıyor; o yatırım interaktif editör yazanların yükü, bizim değil.

**3D UX kabul kriterleri (kayıt — "en az Flux kadar" ölçülebilir hali):**
- Serbest gezinme: orbit / zoom / pan, kartı ters çevirip alt yüz; damping'li kamera ("3D programında model inceler gibi").
- Performans: orta donanımda ~60fps hedef (Kademe-2 GLB sahnesi; draco/meshopt sıkıştırma gerekirse).
- Görsel: PBR materyaller + HDRI ortam ışığı + temas gölgesi — soldermask parlaması, altın pad metalik yansıması; zoom'da serigrafî/marking okunabilir (Kademe-2'de KiCad gerçek modelleriyle).
- Etkileşim: komponente tıkla → designator/değer/MPN overlay (GLB node-adı → refdes → BOM eşlemesi, V7).
- Kullanıcı hissi: tasarım sırasında 3D **anında** açılır (Kademe-1, jenerik modeller); layout finalize olunca **foto-gerçekçi** sahne gelir (Kademe-2). Netlik: 3D'de gezinilen şey şemanın kendisi değil, şemadan üretilen **fiziksel kart**.

FRONTEND_BRIEF'e ileride §2.12 "Board Preview" (2D + iki 3D kademe + Gerber indir) olarak eklenir — v1 kapsamına girmez.

---

## 4. Moat uzantısı — "sim-verified → layout-constrained" (kimse yapmıyor)

Elimizde rakiplerde olmayan girdi var: **doğrulanmış simülasyondan net-başına gerçek akım.** Bunu layout kısıtına çeviriyoruz:

1. **Akım-farkında iz genişliği (deterministik, LLM'siz):** her net için tran'dan RMS akım → **IPC-2221** kapalı-form → min iz genişliği → adaptörde tscircuit'e net-başına `trace_width` kısıtı.
   - IPC-2221: `I = k · ΔT^0.44 · A^0.725` (dış katman k=0.048, iç k=0.024; A = kesit, mil²) → `genişlik = A / (1.378 · bakır_oz)`. ΔT default 10°C, bakır 1oz; ikisi de parametre.
   - Not: peak değil **RMS** akım kullan — measurements engine'de `rms` metriği zaten var (#132/#142), altyapı hazır.
2. **AI yerleşim kısıtları (LLM, sonra):** decoupling yakınlığı ("C3'ü U1-VCC'ye <3mm"), güç/sinyal ayrımı, kritik-loop minimizasyonu → constraint emission olarak. tscircuit "LLM-compatible tweaking" diye pazarlıyor; ekosistem buna hazır.
3. Pazarlama cümlesi hazır: *"Bu iz, senin doğrulanmış simülasyonuna göre 1.8A taşıyor → 1.2mm."* Quilter dahil kimse sim-verified → layout-constrained zincirini kapatmıyor.

### 4.1 Editör merdiveni Basamak 2 — Constrained Layout Editor (Faz 4 vizyonu, kayıt)
Kullanıcının gerçekten istediği elle iz çizmek değil; **müdahale edip gerisini sisteme bıraktırmak.** Kapsam:
- Müdahaleler: komponent sürükle/taşı + **kilitle**, net-başına genişlik override, keepout bölgesi, bağlantı hint'i ("bu neti üstten götür"), katman tercihi.
- Döngü: her müdahale → **otomatik yeniden route → DRC → yeniden doğrulama (sim re-verify)** → verdict güncellenir. *"Her düzenlemenin yeniden doğrulandığı kart"* — ne Flux ne KiCad yapabiliyor (altlarında sim-verify döngüsü yok); moat'ın editöre uzantısı.
- Substrate: tscircuit hint/override/pin (pcbX-pcbY) primitifleri (envanteri V10'da çıkarılır) + mevcut pipeline'ın yeniden koşumu. Tam editörün ~1/5 maliyeti; ayrı sprint, viewer'dan sonra.
- Basamak 3 (manuel iz çizme) bilinçli olarak **talep-kapılı** kalır.

---

## 5. Bilinçli YAPILMAYACAKLAR / ERTELENENLER

**Hiç yapılmayacak:** kendi routing motorumuz · kendi DRC motorumuz (kicad-cli'ninki) · kendi copper-pour *motorumuz* (GND pour ihtiyacı KiCad zone'ları/araçlarıyla — V9) · kendi footprint/3D-model kütüphanemiz (küratörlü harita + footprinter + KiCad kütüphanesi; sonra SnapMagic) · custom WebGL render motoru (Three.js yeter) · RF/high-speed iddiası.

**Talep-kapılı (şimdi değil):** manuel iz çizme / push-and-shove editörü (§1.2 Basamak 3) — "layout'u elimle düzeltmek isterim" sinyali gelmeden inşa edilmez; gelirse tscircuit editör-primitifleri üstüne.

---

## 6. Fazlama + efor (tscircuit'le revize)

| Faz | İş | Süre (tek kişi, ~tahmin) |
|---|---|---|
| 0 — PoC (spike) | Adaptörün iskeleti: 5-komponentli bir devreyi elle circuit-json'a çevir → footprinter → autoroute → gerber. Kalite/uyum kanıtı. **Runtime'a dokunmaz, ayrı script.** | 2-4 gün |
| 1 — Adaptör + hat | `footprint` alanı + küratörlü harita + CircuitJson→circuit-json adaptörü + autoroute + gerber + kicad export | ~1 hafta |
| 2 — Worker + noter | LayoutJob (Prisma+queue+consumer, Reçete B) + kicad-cli DRC container + çıktı paketleme | ~1 hafta |
| 3 — Moat | IPC-2221 net-genişlik (RMS'ten) + AI kısıt-emission (API-gated kısmı sonra) | ~3-5 gün |
| FE | 2D pcb-viewer + Kademe-1 3D (tscircuit) + Kademe-2 GLB viewer (R3F+drei) + render.png thumbnail | ~1 hafta |
| 4 — Kısıt editörü (§4.1) | taşı/kilitle/override/keepout → auto re-route + DRC + **re-verify**; tscircuit hint primitifleri üstüne | viewer'dan sonra, ayrı sprint (~2-3 hafta) |

İlk uçtan-uca demo ("prompt → doğrulanmış → route'lanmış → Gerber") ≈ **2-3 hafta**. (Önceki 6-10 haftalık tahmin, tscircuit keşfiyle düştü — .kicad_pcb yazıcısı, footprint sistemi, DSN köprüsü, Gerber yazıcı paketten geliyor.)

---

## 7. Senden istenenler (pressure-test + doğrulama — inşa DEĞİL)

Önceki brief'lerdeki disiplinle: **onaylamak için değil, çürütmek için oku.** Web-araştırması bulguları Mart-2026 topluluk kaynaklarından; paket adları/durumlar kaymış olabilir. Şunları doğrula/raporla:

- **V1 — paket gerçekliği:** npm'de güncel adlar/versiyonlar/lisanslar: tscircuit core, `circuit-json`, `circuit-json-to-gerber`, DSN converter (gerçek adı?), `footprinter`, `pcb-viewer`, kicad converter. MIT mi hâlâ? Aktif mi (son yayın tarihi)? Pin'lenecek versiyonları öner.
- **V2 — adaptör gap analizi:** bizim `CircuitJson` (Component/Net/PinConnection + properties) ↔ onların circuit-json (source_component / pcb_component / pcb_port / pcb_trace / pcb_board). Alan-alan eşleme tablosu + gerçek zorluklar (ör. bizim net-merkezli model ↔ onların element-array modeli; designator/rotation/değer taşınması; subckt/op-amp gibi çok-pinli parçaların footprint eşleşmesi).
- **V3 — noter + router altyapısı:** `kicad-cli pcb drc` güncel komut yüzeyi + resmi/güvenilir Docker imajı; freerouting self-host güncel durumu (API servisi mi CLI mi). GPL süreç-sınırı hijyenini teyit et.
- **V4 — autorouter kalite iddiası:** "sub-second 4-layer" pazarlama olabilir. Faz-0 PoC'ta 2-3 gerçek devremizle (ör. CE amp + regülatör + karışık analog/dijital) tscircuit yerel autorouter vs freerouting kalitesini kıyasla; plana ancak PoC'tan sonra güven.
- **V5 — akım verisi gerçeği (moat için kritik):** IPC-2221 net-başına RMS **akım** ister; bizim probe'lar ağırlıkla **gerilim**. ngspice'ta akım okuma kısıtları gerçek: kaynaklardan `i(V...)` doğrudan; dirençlerden `@r[i]` veya seri 0V ölçüm kaynağı gerekir. Mevcut measurements/verdict altyapısından net-akımı çıkarmanın en ucuz yolunu tasarla (aday: verdict koşusuna otomatik akım-probe enjeksiyonu vs. deck'e @-vektörleri). Bu çözülmeden "1.8A → 1.2mm" cümlesi kurulamaz — muhtemelen işin en az hazır parçası.
- **V6 — lisans hijyeni:** MIT (tscircuit) → core'a import OK; GPL (freerouting, KiCad) → yalnız ayrı süreç/container, çıktı dosyaları temiz.
- **V7 — GLB kalite + tıkla-bilgi-gör:** küçük bir kartta `kicad-cli pcb export glb`'yi tüm include bayraklarıyla koş: (a) görsel kalite Flux-kıyası (silkscreen/soldermask flat-face olarak nasıl duruyor, iz/via detayı yeterli mi, dosya boyutu makul mu — bayraklar "time consuming" uyarılı, süreyi ölç); (b) GLB node adları komponent refdes'ine deterministik eşleniyor mu (tıkla→designator/değer/MPN overlay'i için raycast eşlemesi buna bağlı). Ek: `pcb render` preset'leriyle 2-3 örnek PNG üret, thumbnail kalitesini gör.
- **V8 — tscircuit 3d-viewer olgunluğu:** `@tscircuit/3d-viewer` güncel durum — vanilla-THREE (v01) geçişi bitti mi, React 19 uyumu, bizim circuit-json adaptör çıktımızla doğrudan render (Kademe-1'in fizibilite testi). Sorunluysa Kademe-1'i atlayıp yalnız Kademe-2 (GLB) ile başlamak meşru bir sadeleştirme — not düş.
- **V9 — GND pour / zone fill (headless):** Flux'ta "Fill" standart; bizim hatta bakır dolgunun en ucuz headless yolu ne? Adaylar: tscircuit'te pour desteği var mı; converter'ın .kicad_pcb'ye zone yazması + doldurmanın nerede gerçekleştiği (kicad-cli export mevcut fill'i mi kullanır, refill için pcbnew Python scripting mi gerekir — container'da mümkün). v1 pour'suz mu çıkar, karar ver ve not düş.
- **V10 — katmanlar + müdahale yüzeyi (kısıt-editörünün substrate'i):** (a) 2-katman v1 / 4-katman yolu: converter + freerouting/tscircuit router çok-katmanı uçtan uca taşıyor mu ("sub-second 4-layer" iddiasını bizim devrelerle test et); (b) tscircuit'in hint/override/kilitleme primitiflerinin envanteri (pcbX-pcbY pinleme, trace hint, net genişlik override, keepout benzeri) — §4.1 için "var olan vs bizim inşa edeceğimiz" tablosu.
- İstersen çıktı olarak: V1-V10 raporu + Faz-0 PoC planı (script seviyesinde). **Runtime'a, design-core'a, multi-candidate'e dokunma — dondurma geçerli.**

## 8. Sıralama (değişmedi)

bakiye → S4 deneyi → SMOKE → canlı N=4 → frontend v1 → **bu pipeline**. Faz-0 PoC istisna olabilir (runtime'a dokunmayan ayrı script olduğu için beklerken yapılabilir) — ama S4/N=4 hazırlığının önüne geçmesin.

---

## 9. V1-V10 doğrulama raporu sonuçları (2 Tem 2026) — kayıt + kabul edilen revizyonlar

Diğer AI, §7'deki V-görevlerini **gerçek koşularla** kapattı (scratchpad Faz-0 PoC: 6-komponentli kart → headless eval → autoroute 0 hata → Gerber+drill → 24.7KB .kicad_pcb → Docker'da gerçek kicad-cli DRC/GLB/render; 4-katman varyantı dahil). Mimari ayakta; Faz-0'ın "kanıt" yarısı fiilen bitti.

**Bağımsız çapraz-doğrulama (bu oturum):** (a) rapordaki üç repo-iddiası klonda birebir teyit — `Component.footprint`/`mpn` şemada var (circuit.ts:133-135 + zod), `SimMeasurement.rms` + full-precision `raw` hesaplanıyor, `extraProbes` akım probe'ları (`@dev[i]` + savecurrents, gözlemlenebilir/gözlemlenemez ayrımıyla) çalışır durumda; (b) KiCad 10 `pcb drc --refill-zones --save-board` resmi 10.0 CLI dokümanında mevcut, 9.0'da YOK; (c) freerouting regresyonu (#508) gerçek + **ek nüans:** 2.2.3'ün KiCad-10-DSN layer-init bug'ı (#676) → pin "≥2.2.3" değil **tam 2.2.4**.

**Kabul edilen delta'lar (yukarıdaki bölümlere işlendi + burada kayıt):**
1. Noter: `kicad/kicad:10.0-full` (~1.44GB compressed, worker node'da bir kez) — zone refill + 3D modeller + render.
2. Menteşe paket: `circuit-json-to-kicad`; DSN köprüsü: `dsn-converter`; rapor tablosundaki sürümleri **pinle**; `@tscircuit/eval` (MIT) worker'da in-process headless eval.
3. **Adaptör şekli değişti:** element-array kurmak yerine CircuitJson → **tscircuit JSX kodu üret** → `runTscircuitCode` (PoC'ta kanıtlandı, çok daha basit). Çok-pinli subckt → `<chip footprint=...>` + pinId→pin-no haritası adaptörün gerçek işi. UiJson pozisyonları → pcbX/pcbY tohumu.
4. **DRC-uyum kısıt seti:** tscircuit default'ları KiCad kurallarından dar (PoC: 26 ihlal — annular 0.05<0.1, clearance <0.2, drill 0.2<0.3). Adaptör **fab-profili** basar (JLC-uyumlu: trace ≥0.2mm, via drill ≥0.3, annular ≥0.1) ve **aynı profil .kicad_pcb design-rules olarak da yazılır** → noterin denetlediği kurallar = adaptörün bastığı kurallar, tek doğruluk kaynağı. IPC-2221 genişlikleri bu profile net-başına minimum olarak biner.
5. **Tıkla-bilgi-gör:** GLB node-adı→refdes plain imajda TUTMADI (OCCT etiketleri) — birincil plan 10.0-full + model-referanslı footprint ile yeniden test; **fallback plana yazıldı: pozisyon-bazlı raycast** (pcbX/Y bizde, UX aynı).
6. **Lisans bayrakları:** `circuit-json-to-gerber` (manifest boş + LICENSE yok) ve `circuit-json` (ISC manifest, tarball'da dosya yok) → upstream issue aç, netleşene dek "vendor-riski" notuyla pinli kullan.
7. **V5 (moat) beklenenden hazır:** rms + akım-probe altyapısı mevcut; kalan iş yalnız final-verified-tran'a otomatik probe enjeksiyonu + net-başına agregasyon + IPC-2221 zarf-clamp'i (≤35A, ≤400mil, ΔT 10-100°C, 0.5-3oz — dışında sessiz ekstrapolasyon YOK, clamp + uyarı). Saturn'ün IPC-2152 kullandığı not edildi; 2221 muhafazakâr default, 2152 gelecek upgrade.
   - **Agregasyon iyileştirmesi (bu oturumun eki):** "net'e bağlı gözlemlenebilir elemanların max-RMS'i" kuralı, karışık net'lerde (gözlemlenebilir küçük dal + Q/M/D gibi gözlemlenemez BÜYÜK dal) genişliği DÜŞÜK tahmin edebilir. Kural sıkılaştırması: net **gözlemlenemez cihaz pinine değiyorsa** → ya (a) yalnız final tran'a o dala seri 0V sense kaynağı enjekte et, ya (b) "unknown → default genişlik + dürüst not". "Yalnız-unobservable net" değil, "unobservable-**touching** net" tetiklesin.
8. **Rekabet taraması (Tem 2026):** zincir hâlâ boş — Flux sim+auto-layout'u kablolamıyor (akım kullanıcı girdisi), Quilter IPC-genişlikte akımı beyan/sezgisel alıyor, Diode en yakın felsefe ama zincir kapalı değil. Multisim Live EOL 15 Eyl 2026 teyit. **Hukuk notu:** Cadence US7490309B1 işaretlendi (~Mart 2027 doluyor) — ticarileştirme öncesi **vekil** değerlendirmesi; bu oturumda bağımsız doğrulanmadı, aksiyon maddesi olarak kalsın.
9. **V8 açık kalem:** @tscircuit/3d-viewer fizibilitesi (rate-limit'e takıldı) — sorunluysa Kademe-1'i atla, yalnız Kademe-2 (GLB), plan zaten buna izinli.

**Kalan Faz-0 işleri (script-seviyesi, runtime'sız, boş beklemelerde):** (1) 10.0-full ile refill-DRC + model-gövdeli GLB/render + node-adı→refdes yeniden testi; (2) converter'a zone/pour yazdırma (`pcb_copper_pour` → .kicad_pcb zone) + 10.0 refill; (3) gerçek 2-3 devreyle tscircuit-router vs freerouting **2.2.4 vs 1.9** kalite kıyası; (4) 3d-viewer fizibilite (V8); (5) Gerber'ların bağımsız görüntüleyicide (gerbv) sağlık kontrolü.

**Sıralama değişmedi:** bakiye → S4 → SMOKE → canlı N=4 → frontend v1 → bu hat. Runtime dondurması geçerli.

---

## 10. Faz-1 dosya-seviyesi plan — ONAY + koşullar (2 Tem 2026, akşam)

Faz-1 planı ("packages/pcb-core") **onaylandı** — pcb-core izolasyonu (genç ekosistem, 391-testlik eda-core'a karışmaz; yalnız tip alır), layoutability dürüstlüğü, fab-profile tek-kaynak ilkesi, `perNetMinWidth` Faz-3 hook'u, mock'suz test felsefesi ve guardrail'ler doğru. Onay, "boş-bekleme işi" istisnasının Faz-0 script'ten pcb-core kütüphane işine genişletilmesi demektir; guardrail aynen: **bakiye dönerse S4→SMOKE→N=4 bu işi keser**, kullanıcıya açılış frontend v1'le.

**Onay koşulları (inşa sırasında karşılanacak):**
1. **Bağlantı-parite denetimi (pin seviyesinde) — kritik.** KiCad DRC'nin "0 unconnected"ı yalnız "kart, tscircuit netlist'ine sadık" der; **"tscircuit netlist'i BİZİM netlist'e sadık" demez.** Adaptörde pin-map hatası (BJT C↔E, diyot anot↔katot, subckt pin kayması) DRC-temiz ama elektriksel-yanlış kart üretir — devre-doğruluğu denetimindeki "simüle oluyor ama yanlış" sınıfının kart karşılığı. Çözüm ucuz: eval sonrası her source_port→net üyeliğini bizim pinId→net üyeliğiyle **pin-seviyesinde izomorfizm** testi. Hem integration assert'i hem `layoutCircuit` içinde kalıcı diagnostic (her koşuda bedava güvence). Bu tek denetim, tip-başına pin-map testlerinin tamamını mekanik kapsar. *(Uygulama sıkılaştırması: denetçi adaptörün kendi haritasını kullanırsa sistematik harita hatası iki tarafta aynı olur — paylaşılan-kader; tscircuit native elementlerinin SEMANTİK port adları (.anode/.collector) haritadan bağımsız çapa sağlar → izomorfizm + polarize/çok-pinli tipler için semantik-çapa testleri.)*
2. **Excluded politikası: warn yetmez.** Load-bearing komponent (transformer, logic_*) dışlanırsa default **FAIL** (`allowPartial: true` opt-in) + sonuçta `completeness: 'full' | 'partial'`; "DRC-temiz damgası"/üretilebilir-paket dili yalnız `full`'da. (Kaynak→konnektör exclusion değil, doğru fiziksel yorum — aynen kalsın.)
3. **İdeal-komponent boşluğu (op-amp rails):** ideal subckt'ın V+/V− portu olmayabilir; SOIC-8'e maplenince güç pinleri boşta kalır. Politika: footprint pin > subckt port → eşlenmeyen pinler açıkça **NC beyanı** ya da komponent `needs-attention`; fixture (c) tam bu vakayı içersin. *(Not: seed OPAMPGEN'in vcc/vee'si VAR (5 port) — 8-pin SOIC'e eşlemede 3 pin NC vakası fixture (c)'de kendiliğinden test edilir.)*
4. **LED dedektörü (şemadan çözüldü):** `led` tipi yok; doğru kural `type==='diode' && modelRef 'led_*'` (kütüphane: led_red/LEDRED...). Tablodaki "properties.led?" satırı buna göre düzeltilsin.
5. **Küçükler:** `opts.router: 'fast'|'quality'` imzaya şimdiden (0-via freerouting bulgusundan sonra Faz-2'de kalite kademesi neredeyse kesin — kırılımsız otursun) · integration testler network-free doğrulansın (tscircuit **local** router'a explicit pin; cloud'a sessiz düşüş determinizmi bozar) · bugünkü yoğun-kart koşusunun gerçek SES'i `mergeSes` için **golden fixture** (kalan-iş #4'ü kısmen bedavaya kapatır) · annular 0.15 (plan) vs 0.1 (rapor): sıkı taraf seçili, sorun değil — tek satır tutarlılık notu.

**İkinci-tur Faz-0 sonuçları kayda geçti:** V9 pour uçtan uca kapandı (zone-injection + KiCad-10 headless refill kanıtlı), GLB refdes fallback'i kesinleşti (pozisyon-raycast), yeni bulgu: converter model-ref yazmıyor → **adaptörün model-ref enjeksiyonu Faz-1 işi** (kılıf→KiCad 3D model yolu haritası), 3d-viewer peerDeps React 19 uyumlu, tracespace bağımsız Gerber doğrulaması 10/10, yoğun-kartta freerouting 2.2.4: 20/20, 2.06s, **0 via** (tscircuit 36 via) → kalite kademesi teyit; "quality-default" kararı bizim gerçek devre kıyasından sonra Faz-2'de.
