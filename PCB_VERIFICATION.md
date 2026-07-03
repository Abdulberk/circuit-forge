# PCB Brief — V1-V10 Doğrulama Raporu (2 Tem 2026)

> PCB_BRIEF.md §7'nin istediği pressure-test. Yöntem: **gerçek testler önce** (npm registry sorguları,
> scratchpad'de çalışan Faz-0 PoC zinciri, Docker'da gerçek kicad-cli koşuları), web-doğrulama ikinci
> (çok-ajanlı araştırma + şüpheci re-verify, birincil kaynak URL'leriyle). Runtime'a/design-core'a
> dokunulmadı — dondurma geçerli.

## 0. Yönetici özeti

**Brief'in mimarisi AYAKTA — hatta tahmin ettiğinden daha hazır.** Faz-0 PoC zinciri bu oturumda
scratchpad'de gerçekten koştu: 6 komponentli kart (SOIC-8 + pasifler + LED) → headless eval →
**autoroute (6 trace + 2 via, 0 hata, 3.2s)** → 9-katmanlı Gerber seti + drill → **24.7KB .kicad_pcb** →
Docker'da gerçek `kicad-cli` ile **DRC (26 ihlal yakaladı, 0 kopuk bağlantı)** + **GLB (0.44s, 205KB)** +
**raytraced render (3.1s, okunabilir serigrafîli kart fotoğrafı)**. 4-katman varyantı da geçti (router
top+inner2 kullandı).

**Moat iddiası rekabet taramasıyla TEYİT:** Temmuz 2026 itibarıyla hiçbir oyuncu
"sim-verified → net-başına gerçek RMS akım → IPC-2221 iz genişliği → route → DRC → her düzenlemede
re-verify" zincirini ürün olarak kapatmıyor. En yakın iki oyuncu bile: **Flux** sim'i VE auto-layout'u
aynı üründe tutuyor ama KABLOLAMIYOR (akımı kullanıcı elle "Current" property olarak giriyor);
**Quilter** IPC-genişliği yapıyor ama akımlar kullanıcı beyanı/sezgisel varsayılan (3V altı netlere
200mA/500mA gibi kurallar) — simülasyondan gelmiyor.

**Kritik düzeltmeler** (brief güncellenmeli): noter sürümü **KiCad 10.0-full** olmalı (zone refill CLI'da
yalnız 10'da; plain tag'de 3D modeller YOK); freerouting **GPLv3** ve **v2.x kalite regresyonu** var
(**tam 2.2.4 pinle**, v1.9'la kıyasla); GLB node-adı→refdes eşlemesi ampirik olarak DOĞRULANAMADI (fallback
hazır); iki pakette lisans dosyası eksik.

> **Çapraz-doğrulama (2 Tem 2026, ikinci oturum):** Bu rapor bağımsız olarak doğrulandı — üç repo-iddiası
> klonda birebir teyit, KiCad-10 refill resmi doc'tan teyit, freerouting regresyonu teyit. İki değişiklik
> kabul edildi ve hem bu rapora hem PCB_BRIEF §9'a işlendi: (1) freerouting pin **tam 2.2.4** (2.2.3'ün
> KiCad-10-DSN #676 bug'ı; V4 bölümünde nüanslı gerekçe), (2) V5 net-akım agregasyonunda
> **"unobservable-touching net"** tetikleyicisi + seri-0V-sense seçeneği (V5 bölümünde).

---

## 1. Bu oturumda koşulan GERÇEK testler

| Test | Sonuç | Kanıt |
|---|---|---|
| tscircuit headless eval (6 komponent) | ✅ 3.2s, 173 element | scratchpad/pcb-poc/poc.mjs |
| Yerel autorouter | ✅ 6 pcb_trace + 2 pcb_via, **0 hata** | aynı koşu |
| Trace segment `width` alanı (moat kancası) | ✅ `{"width":0.15,"layer":"top"}` — net-başına genişlik buraya oturur | circuit.json |
| Gerber + drill üretimi | ✅ F_Cu/B_Cu/silk/mask/paste/Edge_Cuts + drill.drl | out/*.gbr |
| .kicad_pcb üretimi (menteşe) | ✅ `CircuitJsonToKicadPcbConverter` 24.7KB yazdı | out/board.kicad_pcb |
| kicad-cli 9.0.9 DRC (Docker) | ✅ ÇALIŞTI: 26 ihlal + **0 unconnected** (bağlantı bütünlüğü zincirde korunuyor) | out/drc.json |
| DRC ihlallerinin doğası | tscircuit varsayılanları KiCad kurallarından dar: annular 0.05<0.1, clearance 0.13-0.19<0.2, drill 0.2<0.3 → **adaptörde fab-uyumlu kısıt seti gerek** (çözülebilir; moat zaten genişlikleri set edecek) | drc.json |
| GLB export (tüm include bayrakları) | ✅ 0.436s, 205KB — "time consuming" bizim ölçekte sorun değil | out/board.glb |
| **GLB node adı → refdes** | ⚠️ **REFDES DEĞİL** — `=>[0:1:1:2]` OCCT etiketleri (plain imaj, 3D modelsiz). Tıkla-bilgi-gör için: (a) 10.0-full + model referanslı footprint dene, (b) çalışmazsa **pozisyon-bazlı fallback** (raycast noktası → pcbX/Y'den en yakın komponent) — güvenilir ve basit | GLB JSON chunk parse |
| Raytraced render | ✅ 3.1s, 419KB PNG — yeşil mask, **okunabilir serigrafî** (U1/R1.../LED1), izler/pad/via görünür, izometrik+gölge. Komponent gövdesiz (plain imaj) | out/render.png |
| 4-katman (V10a) | ✅ `num_layers:4`, router **top+inner2 fiilen kullandı**, 0 hata | poc4.mjs |
| npm registry (V1) | ✅ aşağıda | `npm view` canlı |

## 2. V1-V10 durum tablosu

### V1 — Paket gerçekliği ✅ (canlı npm sorgusuyla)
| Paket | Sürüm | Lisans | Son değişiklik | Not |
|---|---|---|---|---|
| tscircuit | 0.0.1985 | MIT | **2026-07-02 (bugün)** | çok aktif |
| @tscircuit/core | 0.0.1380 | manifest boş; repo MIT ekosistemi | bugün | |
| circuit-json | 0.0.443 | ISC (manifest) | 30 Haz | tarball'da LICENSE dosyası YOK |
| circuit-json-to-gerber | 0.0.78 | **manifest boş + LICENSE yok** ⚠️ | 10 Haz | upstream'e lisans sor / issue aç |
| **circuit-json-to-kicad** | 0.0.156 | **MIT** (dosya var) | 30 Haz | **menteşe BU** — brief'teki `kicad-converter` değil |
| **dsn-converter** | 0.0.91 | ? | 16 Haz | freerouting köprüsünün gerçek adı (brief'in sorusu cevaplandı) |
| @tscircuit/footprinter | 0.0.363 | ISC | 30 Haz | |
| @tscircuit/pcb-viewer | 1.11.374 | MIT | 22 Haz | |
| @tscircuit/3d-viewer | 0.0.571 | manifest boş | 24 Haz | |
| @tscircuit/eval | (kurulan) | **MIT** (dosya var) | — | headless eval çalışıyor (PoC) |
| kicad-converter | 0.0.17 | — | **Tem 2025 (bayat)** | KULLANMA |
| kicad-mod-converter | 0.0.30 | ISC | **Tem 2024 (bayat)** | footprint importu için alternatif ara |

Pin önerisi: yukarıdaki sürümleri pinle; `dsn-converter` + `circuit-json-to-kicad` + `@tscircuit/eval` üçlüsü hattın belkemiği.

### V2 — Adaptör gap analizi ✅ (yerel)
- **`Component.footprint` alanı ZATEN VAR** (circuit.ts:135, parts-catalog işinden) + `mpn`/`manufacturer`/`sourcing` → tıkla-bilgi-gör verisi hazır. Brief'in "yeni alan" adımı fiilen bitmiş.
- tscircuit circuit-json: **158 element tipi** (zod şemasından çıkarıldı). Bizim ihtiyaç: `source_component`/`pcb_component`/`pcb_port`/`pcb_trace`/`pcb_board` çekirdeği + hazır bulunan: **`pcb_copper_pour`/`pcb_ground_plane`(V9!), `pcb_keepout`/`pcb_trace_hint`/`pcb_manual_edit_conflict_warning`(V10!)**, clearance/overlap error tipleri (DRC yüzeyi büyüyor).
- Pratik adaptör yolu (PoC'ta doğrulandı): tscircuit **kod üretmek** (JSX string) → `runTscircuitCode` — element-array'i elle kurmaktan çok daha basit; bizim Component→`<resistor/capacitor/chip footprint=.. pcbX/Y>` + Net→`<trace from/to>` çevirisi düz. Çok-pinli subckt (op-amp) → `<chip footprint="soic8">` + pin eşlemesi (pinId→pin numarası haritası adaptörün gerçek işi).
- UiJson.positions/rotation → pcbX/pcbY/rotasyon tohumu olarak taşınabilir.

### V3 — Noter + router altyapısı ✅ (web + gerçek koşu)
- `kicad-cli pcb drc`: `--exit-code-violations` (ihlalde exit 5) + `--format json` (şema: schemas.kicad.org/drc.v1.json) + `--schematic-parity` + severity bayrakları — resmi 9.0 docs. Gerçek koşuda json raporu doğrulandı.
- Docker: resmi `kicad/kicad` (CI amaçlı). **KRİTİK: plain tag'de kicad-packages3D YOK** (Dockerfile `include_3d` ARG'ı yalnız `-full`'da) → GLB/render'da komponent gövdesi için **`kicad/kicad:10.0-full`** (~1.44GB sıkıştırılmış; 9.0-full ~1.11GB).
- freerouting: aktif (v2.2.4, May 2026), resmi imaj `ghcr.io/freerouting/freerouting`, CLI `--gui.enabled=false -de in.dsn -do out.ses` VE API servis modu (:37864 — **auth default KAPALI, izole network'e koy**; v2.2.1 auth-bypass fix'i). Host servis adları düzeltme: freerouting.app / api.freerouting.app (beta).

### V4 — Autorouter kalite iddiası ⚠️ kısmen
- Bizim küçük kartta tscircuit yerel router temiz ve hızlıydı (2 ve 4 katman). "Sub-second 4-layer" bizim ölçekte tutuyor; **büyük/gerçek devrelerde kıyas hâlâ Faz-0 işi**.
- **freerouting v2.x kalite REGRESYONU gerçek** (Discussion #508, çözülmemiş; v1.9'un tam route'ladığı kartlarda v2.x 28-81 kopuk bırakabiliyor). Benchmark'a **v1.9.0 jar'ını da** kat.
- **Pin: tam `2.2.4`** (çapraz-doğrulama sonrası revize; önceki önerim "≥2.2.3" idi). İki sebep: 4-katman <2.2.3'te sessiz kırıktı; VE 2.2.3'te KiCad-10-DSN layer-init bug'ı var (#676, 2.2.4'te fix+regresyon testi). *Dürüst nüans:* bizim mimaride freerouting'e giden DSN **KiCad'den değil `dsn-converter`'dan** çıkar (KiCad routing'in AKIŞ AŞAĞISINDA, noter) — #676 bizi doğrudan ısırmayabilir; ama dsn-converter'ın lehçesi KiCad-benzeri olabilir ve 2.2.4 zaten tüm fix'leri kapsıyor → kesin pin her durumda doğru karar.

### V5 — Akım verisi gerçeği ✅ beklenenden HAZIR (yerel kod doğrulaması)
- `SimMeasurement.rms` **zaten her seride hesaplanıyor** (measurements.ts:114).
- `extraProbes` akım probe'ları **çalışır durumda**: `i(R1)` → `@r1[i]` + `savecurrents` (generator.ts:365-411); R/C/V/L/E/H gözlemlenebilir; D/Q/M/X'in branch vektörü yok (bilinen sınır — verdict altyapısıyla aynı).
- Eksik olan SADECE: final verified tran'a otomatik akım-probe enjeksiyonu + **net-başına agregasyon**. Efor: küçük.
- **Agregasyon kuralı (çapraz-doğrulamada sıkılaştırıldı):** ilk önerim "net'e bağlı gözlemlenebilir elemanların max-RMS'i" idi — diğer AI haklı bir delik buldu: akımın DALLANDIĞI bir net'te küçük dal gözlemlenebilir (R) ama büyük dal gözlemlenemezse (Q kollektörü / M drain), max-RMS **düşük** çıkar → iz ince kalır → tam moat cümlesinin yanlışlanacağı yer. Düzeltilmiş kural: tetikleyici "yalnız-gözlemlenemez net" değil, **"gözlemlenemez cihaz pinine DEĞEN net"** — o netlerde ya (a) final tran'a o dala **seri 0V sense kaynağı** enjekte et (klasik ampermetre; devre davranışını değiştirmez), ya (b) dürüstçe "unknown → default genişlik + not". Kabul edildi, brief §9.7'ye işlendi.
- **IPC-2221 formülü bire bir DOĞRU** (Digi-Key/Bittele ile bit-for-bit): `I = k·ΔT^0.44·A^0.725` (dış k=0.048 / iç k=0.024, A mil²), `genişlik_mil = A/(1.378·oz)`; default ΔT=10°C/1oz makul. Geçerlilik zarfı: **≤35A, ≤400mil, ΔT 10-100°C, 0.5-3oz** — dışında sessiz ekstrapolasyon YAPMA (clamp + uyarı). Not: Saturn **V5+ 2152 kullanır** (brief'teki "V5" adlandırmasıyla karışmasın); 2221 muhafazakâr default olarak meşru, 2152 gelecekte upgrade.

### V6 — Lisans hijyeni ✅ (iki bulgu ile)
- MIT/ISC çekirdek importu temiz: tscircuit/eval/pcb-viewer MIT; footprinter/circuit-json ISC; **circuit-json-to-kicad MIT** (dosya mevcut).
- ⚠️ `circuit-json-to-gerber` (manifest boş + dosya yok) ve `circuit-json` (dosya yok): upstream'e issue aç / lisans netleşene dek "vendor-riski" notuyla pinle.
- GPL süreç-sınırı: **FSF FAQ ile teyit** (ayrı süreç + pipe/dosya = ayrı program; çıktı dosyaları GPL-bulaşmasız). freerouting **GPLv3** (brief "v2" diyordu — düzelt). KiCad GPLv3+; Gerber/GLB çıktıları serbest.

### V7 — GLB kalite + tıkla-bilgi-gör ⚠️ kısmen (gerçek koşuyla)
- Hız/boyut mükemmel (0.44s/205KB küçük kartta); "time consuming" bayrakları bizim ölçekte önemsiz. Boyut için gerekirse gltfpack/Draco.
- **Node-adı→refdes bu testte TUTMADI** (OCCT `[0:1:1:2]` adları; kaynak kodda refdes XCAF etiketi VAR ama plain-imaj/modelsiz kartta node'lara inmedi). Aksiyon: 10.0-full + model-referanslı footprint'lerle tekrar dene; **tutmazsa pozisyon-bazlı raycast fallback** (pcbX/Y bizde) — UX aynı, mühendislik basit.
- Render kalitesi: çıplak kart için gayet iyi (serigrafî okunur). "Flux-seviyesi" için komponent gövdeleri şart → `-full` imaj + converter'ın 3D model referansı yazması (`resolveAndLoadKicad3dModelFiles` export'u umut verici — Faz-0'da test).

### V8 — @tscircuit/3d-viewer ⏳ (araştırmacı rate-limit'e takıldı — açık kalem)
- Paket aktif (0.0.571, 24 Haz). Vanilla-THREE geçişi/React-19 durumu doğrulanamadı. Brief'in kendi önerisi geçerli: sorunluysa **Kademe-1'i atla, yalnız Kademe-2 (GLB) ile başla** — meşru sadeleştirme.

### V9 — GND pour / zone fill ✅ (kritik düzeltmeyle)
- Veri modelinde pour VAR (`pcb_copper_pour`/`pcb_ground_plane`/`pcb_thermal_spoke`).
- **KiCad 9 CLI zone refill YAPAMIYOR (REFUTED)** — stale/boş fill'i SESSİZCE plot eder. **KiCad 10.0 (Mart 2026) çözüyor: `pcb drc --refill-zones --save-board` + plot'larda `--check-zones`.** → Noter = **10.0-full**. (10'suz alternatif: pcbnew Python `ZONE_FILLER` script'i — gerek kalmadı.)
- v1 kararı: pour'lu çıkış mümkün; converter'ın zone yazımı Faz-0'da test edilecek (aşağıda).

### V10 — Katmanlar + müdahale yüzeyi ✅ çekirdeği
- (a) 4-katman: **bizim testte uçtan uca geçti** (eval+router); converter'ın inner-layer yazımı Faz-0'a eklendi. freerouting için ≥2.2.3 şartı (yukarıda).
- (b) Primitif envanteri (şemadan doğrulanan): `pcb_keepout`, `pcb_trace_hint`, `pcb_group.autorouter_configuration` (trace_clearance vb.), pcbX/Y pinleme, `pcb_manual_edit_conflict_warning` → kısıt-editörünün (§4.1) substrate'i GERÇEK. Net-başına genişlik: trace segmentlerinde `width` alanı doğrulandı; kaynak-seviyesi kısıt API'si Faz-0'da netleşecek.

---

## 3. Entegrasyon (bizim sisteme) — brief §3'e revizyonlar

Mimarî AYNEN geçerli; deltalar:
1. **Noter imajı: `kicad/kicad:10.0-full`** (zone refill + 3D modeller + render; ~1.44GB compressed — worker node'da bir kez çekilir). DRC komutu: `kicad-cli pcb drc --refill-zones --exit-code-violations --format json`.
2. **Adaptör şekli:** CircuitJson → **tscircuit JSX kodu** → `runTscircuitCode` (element-array'i elle kurmak yerine; PoC'ta kanıtlandı). `@tscircuit/eval` MIT, worker'da in-process.
3. **DRC-uyum kısıt seti:** adaptör default'ları fab-uyumlu bas (trace ≥0.2mm ya da IPC sonucu; via drill ≥0.3/annular ≥0.1 — JLC-uyumlu) yoksa noter 26-ihlal tipi gürültü verir (bugünkü koşunun dersi).
4. **freerouting:** `ghcr.io/freerouting/freerouting:2.2.4` CLI modunda (`-de/-do`), izole network, GPLv3 süreç-sınırı; kıyasa v1.9 jar'ı da dahil.
5. **LayoutJob** (Reçete B LRO) aynen; worker'a +2 imaj (kicad-10-full, freerouting) — ngspice kalıbının kopyası.
6. **Moat (V5) uygulaması:** verified-tasarımın final tran'ına gözlemlenebilir elemanlar için `extraProbes` enjeksiyonu → `SimMeasurement.rms` → net-başına max-RMS → IPC-2221 (zarf-clamp'li) → adaptörde net-başına `trace_width`. LLM'siz, deterministik, ~3-5 gün (brief tahmini doğru).
7. **Tıkla-bilgi-gör:** birincil plan GLB node-adı; **fallback pozisyon-raycast** (bugünkü bulgu gereği plana yazıldı).

Fazlama/effort tablosu geçerli; Faz-0'ın "kanıt" yarısı bugün bitti (aşağıda kalanlar).

## 4. Avantajlar (rekabet taraması sonucu — Temmuz 2026)

| Oyuncu | Durum | Bizim farkımız |
|---|---|---|
| **Flux** | ngspice sim VAR (chat'ten) + RL auto-layout VAR — **birbirine bağlı DEĞİL**; iz genişliği/akım kullanıcı girdisi | zinciri BİZ kapatıyoruz: sim çıktısı kısıtı ÜRETİYOR |
| **Quilter** | IPC-genişlik VAR ama akım = kullanıcı beyanı/sezgisel default (200/500mA); sim yok; per-board fiyat | "senin DOĞRULANMIŞ simülasyonuna göre 1.8A → 1.2mm" cümlesini yalnız biz kurabiliyoruz |
| DeepPCB | RL place&route API (0.50 kredi/dk) — geometrik DRC only | premium router opsiyonu olarak hâlâ takılabilir |
| JITX | kısıtlar kod-yazımı (kullanıcı), SI harici Ansys | otomatik türetim yok |
| Diode ($11.4M a16z) | modül-SPICE + insan layout | en yakın felsefe, zincir kapalı değil |
| Altium/Cadence | yalnız high-end SI'da (SigXplorer) sim→kısıt, manuel/pahalı; power/akım tarafında yok | mainstream'de boş alan |
| Multisim Live | **EOL 15 Eyl 2026 teyit** | eğitim boşluğu zamanlaması bizim lehimize |

⚠️ **Hukuk notu (bilgi, tavsiye değil):** araştırmada **Cadence patenti US7490309B1** işaretlendi (sim→kısıt alanında; ~Mart 2027'de doluyor). Ticarileştirme öncesi kısa bir patent-check makul; bizim spesifik zincir (verified-verdict'li RMS→IPC-2221→autoroute→re-verify) farklılaşıyor ama bunu vekil değerlendirsin.

## 5. Faz-0 ikinci tur sonuçları (2 Tem 2026, akşam — "devam" koşusu, hepsi GERÇEK)

| Test | Sonuç |
|---|---|
| KiCad **10.0.4** (10.0-full imaj) | ✅ çekildi + çalıştı; `--refill-zones` bayrağı kabul; DRC 51 ihlal (10'un kuralları 9'dan sıkı — fab-profili hizasının önemi pekişti), yine 0 kopuk |
| **V9 pour uçtan uca KAPANDI** | tscircuit JSX'te `<groundplane>` YOK (kayıtlı element değil — eval reddetti); ama **zone-injection yolu kanıtlandı**: zone s-expr'ini .kicad_pcb'ye biz yazdık → `kicad-cli pcb drc --refill-zones --save-board` **headless doldurdu** (`filled_polygon` oluştu) → pour'lu Gerber export'ta B_Cu 2052→3091 byte (dolgu bakıra girdi) + `--check-zones` kabul. v1 pour stratejisi: adaptör zone yazar, KiCad 10 doldurur |
| GLB node adları (KiCad 10) | yine OCCT `[0:1:1:N]` — refdes YOK → **pozisyon-raycast fallback KESİNLEŞTİ** |
| **Yeni bulgu: converter 3D model referansı yazmıyor** | .kicad_pcb'de 0 `(model` girdisi → `--subst-models`'in ikame edeceği şey yok; **komponent gövdeli GLB/render için adaptörün model-ref enjeksiyonu gerekecek** (kılıf→KiCad kütüphane yolu haritası; glue-work, Faz-1'e not) |
| V8: 3d-viewer | peerDeps **React 19.1.0** + three ^0.165 — brief'in React-19 endişesi manifest'te çözülmüş; runtime render testi frontend sprintine |
| Gerber bağımsız sağlık | ✅ **tracespace** (KiCad'den bağımsız implementasyon) 10/10 dosyayı parse etti, TÜM katman tiplerini doğru tanıdı, top/bottom SVG render etti |
| **V4 router kıyası (yoğun kart: 2 IC + 12 pasif + 2 LED, 20 net)** | tscircuit: 20/20 route, **36 via**, 6.1s (eval dahil) · **freerouting 2.2.4 (Docker CLI): 20/20, 2.06s, 0 kopuk — ve 0 VİA** (54 tel). Kalite farkı ölçülü ve net: freerouting çok daha temiz layout üretti. Mimari teyit: tscircuit=hızlı varsayılan, freerouting=**kalite kademesi** (kalite-varsayılanı yapmak bile değerlendirilebilir). #508 regresyonu bu yoğunlukta ısırmadı. Docker çağrısı: `--entrypoint java ... -jar /app/freerouting-executable.jar --gui.enabled=false -de in.dsn -do out.ses` (imaj entrypoint'i çıplak arg kabul etmiyor — gotcha) |
| dsn-converter | ✅ `convertCircuitJsonToDsnString` + SES-geri-okuma/merge API'leri tam; DSN 8.6KB yazıldı, freerouting sorunsuz yedi |

## 5b. Kalan işler (küçüldü)
1. **Kendi gerçek devrelerimizle** (CE amp + regülatör + mixed) router kıyasının tekrarı + **v1.9 jar** karşılaştırması (V4'ün tam kapanışı — sentetik yoğun kart geçti, temsili ama bizim devreler nihai söz).
2. Adaptörün **model-ref enjeksiyonu** (kılıf→KiCad 3D model yolu) — gövdesiz GLB/render'ı gövdeye kavuşturur (Faz-1 işi).
3. `@tscircuit/3d-viewer` runtime render testi (frontend sprintinde).
4. SES→circuit-json merge yolunun (freerouting sonucunu hatta geri almak) uçtan uca testi (API mevcut, koşusu Faz-1'de).

## 6. Dürüst görüş (istediğin "ne düşünüyorsun")
- **Büyük eksiklik tespitinde haklısın** — ve iyi haber: bu, korktuğumuz büyüklükte bir inşaat değil. Bugün scratchpad'de 3 saatte prompt-tarafı hariç tüm hat gerçek çalıştı. Ekosistem (tscircuit **bugün bile** commit alıyor) tam bize göre: MIT, TS-native, headless.
- **Moat gerçek ve boş** — rakip taraması bunu üçüncü kez teyit etti; üstelik V5 altyapımız (rms + akım probe'ları) brief'in sandığından hazır. "Sim-verified → layout-constrained" bizim doğal uzantımız; Flux'ın bile kablolamadığı şey.
- **En büyük riskler:** (a) autorouter kalitesi gerçek devrelerde (Faz-0 #3 kapatacak), (b) genç ekosistem API oynaklığı (pin + adaptör-arkasında-izole et), (c) 3D "Flux-seviyesi" iddiası komponent gövdelerine bağlı (10.0-full testi belirleyecek; fallback: pozisyon-raycast + Kademe-2-only).
- **Sıralama brief'teki gibi kalmalı:** bakiye → S4 → N=4 → frontend v1 → bu hat. Faz-0'ın kalan 5 maddesi runtime'sız olduğu için boş beklemelerde bitirilebilir.
