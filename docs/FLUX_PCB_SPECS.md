# Circuit Forge — PCB Üretim Katmanı Spec'i

**Kaynak:** flux.ai'ın "5V to 3V3 Buck Supply" projesinin tam export seti (GenCAD, Gerber+drill, IPC-2581C, ODB++, IPC-D-356, Pick&Place, BOM, EDIF) üzerinde yapılan tersine mühendislik.
**Amaç:** Kanıtlanmış bir üründe gerçekten kırılan noktaları görüp, aynı hataları yapmadan üretim katmanını tanımlamak.
**Durum:** Taslak — §10'daki maddeler repo üzerinde doğrulanmadan kesinleşmiş sayılmaz.

---

## 0. Tek cümlelik tez

> tscircuit **tasarımı yakalar**, KiCad **noter** olur, üretim doğruluğunun tamamı ise `pcb-core`'daki politika ve oracle katmanının sorumluluğudur. Flux'ın kırıldığı yerlerin hepsi bu üçüncü katmanda.

Flux'ın pipeline'ı bizimkiyle neredeyse aynı: iç model → `/tmp/input.kicad_pcb` → yamalı KiCad 9.0.9 (Ubuntu 22.04) → tüm fab formatları. Fark, ara katmanda hangi politikanın uygulandığı ve hangi kapının kurulduğu. Onlarda kapı yok.

---

## 1. Sorumluluk paylaşımı

### 1.1 tscircuit / circuit-json bugün ne veriyor

| Yetenek | Durum | Not |
|---|---|---|
| Şema + PCB tek kaynaktan (JSX → circuit-json) | ✅ | Ana değer |
| Footprint üretimi (`footprinter` string'leri) | ✅ | Geometri doğru üretiliyor, **string seçimi bize ait** |
| `pcb_smtpad` / `pcb_plated_hole` ayrımı | ✅ | Pad seviyesinde tip var |
| `<copperpour />` + `pcb_copper_pour` | ✅ | Net'e bağlı, clearance ayarlanabilir, B-Rep çözücüsü var |
| `<board layers={4}>` | ✅ | inner1/inner2 **routing için** açılıyor |
| `pcb_thermal_spoke` eleman tipi | ✅ | Tip var, **politika yok** |
| `pcb_solder_paste` eleman tipi | ✅ | Tip var, **politika yok** |
| Clearance ölçüm yardımcıları (`computeGapBetweenCopper`, `computeMinimumClearance`) | ✅ | Oracle yazmak için hazır API |
| Hata tipleri (`pcb_pad_pad_clearance_error`, `pcb_pad_trace_clearance_error`, `pcb_trace_error`) | ✅ | Şema var, kapsam dar |
| DSN üretimi (freerouting köprüsü) | ✅ | |
| Gerber / drill / BOM / PnP writer'ları | ✅ | Temel seviye |
| `circuit-json-to-kicad` | ✅ | Alan bazında eksik — §3.4 |

### 1.2 tscircuit'in **yapmadığı**, bizim yapmamız gerekenler

| # | Eksik | Neden tscircuit'e bırakılamaz |
|---|---|---|
| E1 | Malzemeli stackup (kalınlık, Er, tanδ, bakır ağırlığı) | circuit-json'da katman yalnızca bir isim; malzeme modeli yok |
| E2 | Katman **rolü** (signal / plane / mixed) | `layers={4}` sadece routing alanı açıyor; "In1 = GND plane" diye bir kavram yok |
| E3 | Plane bazlı güç dağıtımı + otomatik anti-pad | Pour var ama plane ataması ve anti-pad politikası yok |
| E4 | Stitching via üretimi | Hiç yok |
| E5 | Termal relief politikası (kaç spoke, hangi genişlik, hangi pad'de) | Eleman tipi var, karar yok |
| E6 | Maske genişlemesi ve pasta politikası (EP windowpane, THT'de pasta yok) | Eleman tipi var, karar yok |
| E7 | Komponent seviyesi SMD/THT attribute'u | KiCad'e yazılırken türetilmeli |
| E8 | IPC-2581 / ODB++ / IPC-D-356 / GenCAD | Kapsam dışı — kicad-cli işi |
| E9 | Gerçek DRC | tscircuit'te yok; kicad-cli işi |
| E10 | Çıktılar arası koordinat çerçevesi sözleşmesi | Her writer kendi kararını veriyor |
| E11 | Net sınıfı soyutlaması + IPC-2221 bağlanması | Per-trace genişlik var, sınıf sistemi yok |
| E12 | Fab'a özgü BOM/CPL formatları | Flux'ta 8 BOM + 2 CPL varyantı var; bizde yok |
| E13 | Footprint adı ↔ geometri tutarlılığı, MPN → paket eşlemesi | Katalog bizde (TME), eşleme bizim |
| E14 | Spec ↔ artifact denetimi | Ürün seviyesi kavram |

### 1.3 Katman sözleşmesi

```
┌─ frontend ──────────────────────────────────────────────┐
│  tscircuit runframe / viewer, stackup editor,           │
│  rule inspector, DRC sonuç yüzeyi, export bundle UI     │
└────────────────────────┬────────────────────────────────┘
                         │ circuit-json
┌────────────────────────▼────────────────────────────────┐
│  pcb-core (POLİTİKA + ORACLE)                           │
│  FabProfile v2 · net sınıfları · plane/stitch/thermal   │
│  paste/mask politikası · koordinat sözleşmesi           │
│  circuit-json ⇄ .kicad_pcb köprüsü · O1..O12 oracle'lar │
└────────────────────────┬────────────────────────────────┘
                         │ .kicad_pcb
┌────────────────────────▼────────────────────────────────┐
│  KiCad (NOTER) — kicad-cli                              │
│  drc · zone refill · gerbers · drill · ipc2581 · odb    │
│  ipcd356 · gencad · step/glb · render                   │
└─────────────────────────────────────────────────────────┘
```

Kural: **circuit-json hiçbir zaman doğrudan fab çıktısına gitmez.** Her fab artefaktı `.kicad_pcb`'den ve tek bir profil kaynağından üretilir.

---

## 2. Bulgu → gereksinim izlenebilirliği

Her satır: Flux'ta ölçülen defect → bizim gereksinimimiz → doğrulayan oracle.

| # | Flux'ta gözlemlenen | Ölçüm | Gereksinim | Oracle |
|---|---|---|---|---|
| F1 | `SW` ve `PG_3V3` netleri route'suz; export yine de çıkıyor | IPC-2581'de bu netler için `Line` sayısı 0 | Route'suz net varken üretim paketi üretilemez | O2 |
| F2 | U1'in FB/PGND/AGND pinleri pour'a değmiyor | Pour boşluğu x 41.11–43.39 / y −75.59–−77.10 ve x 41.61–43.39 / y −77.45–−78.96; pad'ler tamamen içeride | Her pad bakırda erişilebilir olmalı | O2, O3 |
| F3 | Pour clearance'ı sabit 0.5 mm, 0.5 mm pitch'te pinleri yutuyor | Boşluk sınırı = komşu non-GND pad + 0.5 mm | Clearance net sınıfına ve pad pitch'ine bağlı | O3 |
| F4 | Her komponent `mountType="THMT"` / `INSERT TH` | IPC-2581 ve GenCAD'de 9/9 | Komponent tipi SMD/THT doğru yazılmalı | O5 |
| F5 | THT konnektör pad'lerine pasta açıklığı | `f_paste.gbr` D15 flash @ (20.7759, −78.7785) | THT'de pasta yok | O5 |
| F6 | WSON EP'de %100 pasta | Pasta aperture = bakır aperture = 1.6×0.9 mm | EP'de windowpane, %50–80 kapsama | O5 |
| F7 | Sıfır maske genişlemesi | f_mask aperture'ları f_cu ile birebir | Profilden gelen maske genişlemesi | O5 |
| F8 | CPL ve d356 kart merkezine, Gerber+drill mutlak origin'e göre | Fark tam (90, −60) mm | Tüm çıktılar tek çerçevede | O4 |
| F9 | IPC-2581'de `rotation` attribute'u yok | Component kayıtlarında alan mevcut değil | Rotasyon her zaman açıkça yazılır | O5 |
| F10 | Jenerik stackup: 3×15 mil, tek Er, `PROPOSED` | 1.299358 mm toplam | Gerçek fab stackup'ı, `status: confirmed` | O11 |
| F11 | İz genişliği akımdan türetilmemiş | 233 mA ve 300 mA netleri aynı 0.15 mm | Net sınıfı → IPC-2221 → katman farkındalı denetim | O6 |
| F12 | Footprint adı geometriyle çelişiyor | `WSON-8_…-P0.65-…` ama pitch 0.5 mm | Ad geometriden türetilir veya doğrulanır | O9 |
| F13 | Pasiflerde MPN ve distribütör kodu yok | JLCPCB BOM'unda 5/6 satır boş | Populate edilen her parça sipariş edilebilir | O10 |
| F14 | `ROOT.top` / `ROOT.bottom` hayalet nesneleri BOM'a sızmış | 2 `BomItem`, biri `refdes=""` | Container nesneleri BOM'dan hariç | O10 |
| F15 | Aynı footprint instance başına yeniden üretiliyor | `Generic Capacitor_3/_6/_7/_9`, J1–J2 ise ortak | Footprint üretimi deterministik | O12 |
| F16 | İpek baskıda 0.05–0.06 mm çizgi ve sıfır çaplı aperture | `%ADD10C,0.000000` | Minimum silk genişliği zorlanır | O8 |
| F17 | Proje açıklaması "2-layer FR4" derken kart 4 katman | readme.txt vs matrix | Spec ile artifact eşleşmeli | O11 |

Flux'ın **geçtiği** tek şey: şema netlist'i (EDIF) ile layout netlist'i (IPC-D-356) pin seviyesinde birebir aynı. Bizim de bunu garanti etmemiz gerekiyor ama bu yeterli değil — F2 tam olarak "netlist doğru, bakır yanlış" vakası.

---

## 3. Veri modeli değişiklikleri

### 3.1 `FabProfile` v2

Tek kaynak ilkesi korunuyor: adaptöre bastığımız kısıtlar ile `.kicad_pcb`'ye yazdığımız design rules aynı nesneden türer.

```ts
interface FabProfile {
  id: string                    // "jlcpcb-4l-1.6mm-hasl"
  vendor: "jlcpcb" | "pcbway" | "elecrow" | ...

  stackup: {
    status: "confirmed" | "proposed"   // proposed ise fab çıktısı üretilemez
    totalThicknessMm: number
    layers: StackupLayer[]             // sıralı, dış→iç→dış
  }

  designRules: {
    minTraceWidthMm: number
    minClearanceMm: number
    minViaDrillMm: number
    minViaPadMm: number
    minAnnularRingMm: number
    minHoleToCopperMm: number
    minSilkWidthMm: number
    minSilkToPadMm: number
    minBoardEdgeToCopperMm: number
  }

  padPolicy: {
    maskExpansionMm: number            // Flux: 0 → hata. Öneri: 0.05
    maskMinSliverMm: number
    pastePolicy: {
      smd: { coveragePct: 100 }
      tht: { coveragePct: 0 }          // F5
      thermalPad: {                    // F6
        pattern: "windowpane"
        targetCoveragePct: [50, 80]
        apertureGapMm: number
      }
    }
  }

  pourPolicy: {
    clearanceMm: number                // taban
    clearanceByNetClassMm?: Record<NetClassId, number>
    finePitchThresholdMm: number       // <= bu pitch'te F3 kuralı devreye girer
    finePitchStrategy: "shrink-clearance" | "via-under-pad" | "thermal-neck"
    minNeckWidthMm: number             // pour'un pad'e ulaşabilmesi için gereken en dar boyun
    thermalRelief: {
      appliesTo: "tht" | "all" | "none"
      spokeCount: number
      spokeWidthMm: number
      gapMm: number
    }
    removeIslands: boolean
  }

  stitching: {
    enabled: boolean
    pitchMm: number                    // Flux: 15 mm sabit
    pitchRule?: "fixed" | "lambda-over-20"
    maxFreqMHz?: number                // lambda kuralı için
    keepoutFromCourtyardMm: number
    nets: NetClassId[]                 // genelde ["ground"]
  }

  coordinate: CoordinateContract       // §7
  outputs: OutputMatrix                // §6
}

interface StackupLayer {
  name: "F.Cu" | "In1.Cu" | "In2.Cu" | "B.Cu" | `DIELECTRIC_${number}` | ...
  kind: "copper" | "dielectric" | "mask" | "paste" | "silk"
  role?: "signal" | "plane" | "mixed"          // E2 — bizim eklememiz
  planeNet?: string                             // role === "plane" ise
  thicknessMm: number
  copperWeightOz?: 0.5 | 1 | 2
  material?: { name: string; er: number; lossTangent: number; type: "core" | "prepreg" }
}
```

**Kritik:** `role` ve `planeNet` circuit-json'da yok. Bunları `pcb-core` tutar ve `.kicad_pcb` üretirken zone olarak maddeleştirir.

### 3.2 Net sınıfı modeli

Flux'un `Nets with Current / Power Nets / GND Net / Analog Nets / High Speed Nets` ağacı doğru soyutlama. Bizde bu kavram yok; IPC-2221 hesabının oturması gereken yer burası.

```ts
interface NetClass {
  id: NetClassId                       // "power" | "ground" | "analog" | "signal" | "high-speed"
  matcher: { names?: string[]; regex?: string; roles?: string[] }
  electrical?: {
    rmsCurrentA?: number               // sim'den gelir
    maxTempRiseC?: number              // varsayılan 10
    targetImpedanceOhm?: number
  }
  physical: {
    minWidthMm?: number                // IPC-2221'den türetilir, katman farkındalı
    preferredLayers?: LayerName[]      // güç netlerini dış katmana kilitlemek için
    viaCountMin?: number               // güç geçişlerinde tek via yasak
    clearanceMm?: number
  }
}
```

IPC-2221 uygulaması **iki aşamalı** olmalı:

1. **Route öncesi:** sınıfa göre hedef genişlik, dış katman varsayımıyla (`k=0.048`).
2. **Route sonrası:** her segmentin gerçek katmanına göre yeniden hesap (`k=0.024` iç katman). İhlal varsa ya genişlet ya yeniden route et. → O6

2 katmanda ikinci aşama no-op; 4 katmana geçer geçmez zorunlu.

### 3.3 Komponent modeli eklentileri

```ts
interface ComponentFabMeta {
  mountType: "smd" | "tht" | "mixed"   // E7/F4 — pad tiplerinden türetilir
  rotationDeg: number                   // her zaman açık yazılır, F9
  heightMm?: number
  thermalPad?: { widthMm: number; heightMm: number }
  footprintName: string                 // O9 ile geometriye karşı doğrulanır
  mpn?: string
  distributorPNs: Record<"lcsc"|"tme"|"digikey"|"mouser", string | undefined>
  isContainer: boolean                  // true ise BOM/CPL/fab dışı — F14
}
```

`mountType` türetme kuralı: komponentin pad'lerinin hepsi `pcb_smtpad` ise `smd`, hepsi `pcb_plated_hole` ise `tht`, karışıksa `mixed`. Bu tek satır Flux'ın F4→F5→F6 zincirini komple keser.

### 3.4 `circuit-json-to-kicad` köprüsünde doğrulanacak/eklenecek alanlar

| Alan | Neden |
|---|---|
| `(attr smd)` / `(attr through_hole)` | F4; IPC-2581 `mountType`, PnP ve DFM buna bağlı |
| `(solder_mask_margin ...)` | F7 |
| `(solder_paste_margin ...)` / paste pad'lerinin ayrı yazımı | F5, F6 |
| zone `(connect_pads (clearance ...))`, `(thermal_gap)`, `(thermal_bridge_width)` | E5 |
| zone `(filled_areas_thickness no)` + `(min_thickness)` | pour boyun genişliği |
| katman tanımında `(user_name ...)` ve plane rolü | E2 |
| `(net_class ...)` blokları | E11 |
| `(model ...)` | zaten var (`models3d.ts`) |

---

## 4. Pipeline

```
 1. circuit-json üretimi           (tscircuit)
 2. FabProfile çözümleme            → stackup.status !== "confirmed" ise DURDUR
 3. Net sınıfı ataması              → IPC-2221 hedef genişlikler (dış katman varsayımı)
 4. Yerleşim                        (mevcut placement.ts / rust placer)
 5. Route                           (tscircuit local | freerouting)
 6. POST-ROUTE GENİŞLİK DENETİMİ    → O6, ihlalde 5'e dön (max 2 tur)
 7. Plane materyalizasyonu          → role="plane" katmanlar için zone; anti-pad'ler
 8. Pour + stitching                → pourPolicy + stitching; keepout farkındalı
 9. Pad politikası                  → mask expansion, paste (SMD/THT/EP), thermal relief
10. .kicad_pcb yazımı               → §3.4 alanlarının hepsi
11. KiCad noteri                    → drc --refill-zones --exit-code-violations
                                      unconnected == 0 değilse DURDUR (O2)
12. Geometrik oracle'lar            → O3, O5, O7, O8, O9
13. Fab çıktıları                   → §6 matrisi
14. Çıktı sonrası oracle'lar        → O1, O4, O10, O11
15. Paketleme + manifest
```

**Kapılar (üretim paketi üretilmez):** 2, 6, 11, 12, 14.
Kapı ihlali kullanıcıya "bu tasarım şu sebeple üretilemez" olarak yüzeylenir — sessizce zip üretilmez. Flux'ın en büyük ürün hatası tam burada.

---

## 5. Oracle kataloğu

Her oracle: girdi → yöntem → geçme ölçütü. Hepsi CI'da koşar, hepsi bir sayı üretir.

| ID | Ad | Girdi | Yöntem | Geçme ölçütü |
|---|---|---|---|---|
| **O1** | Netlist parity | şema netlist + `.d356` | Pin seviyesinde küme eşitliği (`REF.PIN`) | Fark = 0 |
| **O2** | Bakır bağlantı | `.kicad_pcb` | `kicad-cli pcb drc --refill-zones --exit-code-violations` | unconnected = 0, error = 0 |
| **O3** | Pour erişilebilirliği | pour poligonu + pad geometrisi | Her pad için pour ile örtüşme alanı; bağlantı yalnızca pour üzerindense boyun genişliği ölç | Örtüşme > 0 **ve** boyun ≥ `minNeckWidthMm` |
| **O4** | Koordinat çerçevesi | Gerber + drill + CPL + d356 | CPL/d356 satırlarını Gerber çerçevesine geri projekte et | Her nokta ilgili pad poligonu içinde |
| **O5** | Pad politikası | Gerber f_cu/f_mask/f_paste + IPC-2581 | Aperture karşılaştırması + `mountType` denetimi | SMD'de pasta var, THT'de yok, EP kapsama %50–80, maske = bakır + expansion, rotation alanı dolu |
| **O6** | Genişlik/katman | route sonrası circuit-json | Her segment için katman farkındalı IPC-2221 | Genişlik ≥ gerekli, tüm segmentlerde |
| **O7** | Annular ring | drill + pad çapları | `(pad − drill)/2` | ≥ `minAnnularRingMm` |
| **O8** | İpek baskı | f_silks Gerber | Aperture çapları + pad örtüşmesi | Min genişlik ≥ profil, sıfır çaplı aperture yok, silk-over-pad = 0 |
| **O9** | Footprint adı ↔ geometri | footprinter string + üretilen pad'ler | String'den pitch/gövde parse et, ölçülene karşı doğrula | Sapma ≤ 1 µm |
| **O10** | BOM tamlığı | BOM + komponent listesi | Populate edilen her refdes için MPN + ≥1 distribütör kodu; container'lar hariç | Eksik = 0, hayalet satır = 0 |
| **O11** | Spec ↔ artifact | proje spec'i + matrix/stackup | Katman sayısı, kart boyutu, kalınlık, malzeme | Hepsi eşit; `stackup.status = confirmed` |
| **O12** | Determinizm | aynı girdi, 2 koşu | circuit-json + Gerber hash | Byte-identical |

**Uygulama notu:** O3, O4, O7, O9 için `@tscircuit/circuit-json-util`'ün `computeGapBetweenCopper` ve `computeMinimumClearance` fonksiyonları hazır API veriyor — sıfırdan geometri kütüphanesi yazmaya gerek yok. O5 ve O8 doğrudan Gerber aperture listesinden okunur (regex seviyesinde iş).

**Regresyon fikstürü:** Flux'ın bu kartını referans "kötü örnek" olarak repoya koy. O2 ve O3 bu karta uygulandığında **fail** vermeli. Oracle'ın gerçekten çalıştığının kanıtı bu.

---

## 6. Export matrisi

| Çıktı | Üreten | Komut / kaynak | Öncelik |
|---|---|---|---|
| Gerber (RS-274X) | kicad-cli | `pcb export gerbers` | var |
| Drill (Excellon) | kicad-cli | `pcb export drill` | var |
| Pick & place | pcb-core | vendor şablonları (JLCPCB, PCBWay, OpenPNP) | P0 |
| BOM | pcb-core | vendor şablonları | P0 |
| **IPC-D-356** | kicad-cli | `pcb export ipcd356` | **P0** |
| **IPC-2581** | kicad-cli | `pcb export ipc2581` | **P1** |
| **ODB++** | kicad-cli | `pcb export odb` | P1 |
| GenCAD | kicad-cli | `pcb export gencad` | P2 |
| STEP / GLB | kicad-cli | `pcb export step --format glb` | var |
| Render (PNG) | kicad-cli | `pcb render` | var |
| DRC raporu | kicad-cli | `pcb drc --format json` | P0, kapı |
| Manifest (profil + oracle sonuçları + hash) | pcb-core | — | P0 |

**Manifest** paketin içine girer: hangi profil, hangi stackup, hangi oracle'lar hangi değerlerle geçti, girdi hash'i. Flux'ta böyle bir şey yok; "bu paket şu koşullarda doğrulandı" iddiasını taşıyabilen tek şey bu.

Vendor CPL/BOM varyantları için Flux'ın kapsamı referans: BOM'da AdvancedCircuits, AllPCB, Eurocircuits, JLCPCB, PCBWay, Seeed, Elecrow + kendi zengin formatı; CPL'de JLCPCB + OpenPNP. Başlangıç için JLCPCB + PCBWay + OpenPNP yeterli.

---

## 7. Koordinat çerçevesi sözleşmesi

Flux'ın en somut hatası. Sözleşme tek yerde tanımlanır ve **her writer** onu tüketir:

```ts
interface CoordinateContract {
  origin: "board-lower-left" | "board-center" | "sheet-absolute"
  yAxis: "up-positive" | "down-positive"
  unit: "mm" | "in"
  precision: number
}
```

**Öneri:** `origin: "board-lower-left"`, `yAxis: "up-positive"`, `unit: "mm"`.
Gerekçe: JLCPCB ve çoğu montaj evi CPL koordinatını Gerber ile aynı çerçevede ve kart sol-alt köşesine göre bekler. Flux Gerber'ı mutlak (kartın 10 mm dışında origin), CPL'i kart merkezinde üretiyor; iki dosya arasında tam (90, −60) mm kayma var.

Sözleşme sadece dokümante edilmez, **O4 tarafından test edilir**: CPL'deki her satırın koordinatını Gerber çerçevesine geri projekte et, ilgili pad poligonunun içine düşmeli.

---

## 8. Frontend işleri

| # | İş | Neden |
|---|---|---|
| FE1 | Stackup editörü | `role`/`planeNet`/malzeme girilebilmeli; profil `confirmed` olmadan export butonu kapalı |
| FE2 | Net sınıfı paneli | Sınıf ataması, hesaplanan genişlik, hangi katmana kilitli olduğu görünsün |
| FE3 | DRC/oracle sonuç yüzeyi | Kapı ihlali → hangi pad, hangi net, hangi ölçüm. Zip'i sessizce üretme |
| FE4 | Katman görüntüleyici | inner1/inner2'nin plane mi signal mi olduğu ayırt edilebilsin; pour ve anti-pad'ler görünsün |
| FE5 | Pour teşhis görünümü | "Bu pad pour'a şu genişlikte boyunla bağlı" — O3'ün görsel karşılığı, F2'yi kullanıcıya gösterir |
| FE6 | Export bundle ekranı | Format seçimi, manifest önizlemesi, hangi oracle'ın hangi değerle geçtiği |
| FE7 | Spec ↔ artifact rozeti | O11 sonucunu proje başlığında göster (Flux'ın "2-layer" yazıp 4 katman üretmesi tam buradan kaçıyor) |

`@tscircuit/runframe` ve `pcb-viewer` FE4'ün temelini zaten veriyor; FE5 için pour poligonu ile pad geometrisinin kesişimini çizmek gerekir — circuit-json'da her ikisi de mevcut.

---

## 9. Fazlama

**P0 — doğruluk kapıları (bu olmadan "verified" iddiası kurulamaz)**
- O2 kapısı: `kicad-cli pcb drc --refill-zones`, unconnected = 0
- O3: pour erişilebilirliği + boyun genişliği
- O4: koordinat çerçevesi sözleşmesi + testi
- `mountType` türetme + `(attr smd)` yazımı (F4/F5/F6 zincirini keser)
- IPC-D-356 export
- Flux kartını regresyon fikstürü olarak ekle (O2/O3 fail vermeli)

**P1 — stackup ve plane**
- FabProfile v2 stackup + `role`/`planeNet`
- Plane materyalizasyonu, anti-pad, stitching via üreteci
- Termal relief politikası
- O6 katman farkındalı genişlik denetimi
- IPC-2581 + ODB++ export

**P2 — üretilebilirlik derinliği**
- Maske/pasta politikası (windowpane dahil), O5
- O7 annular ring, O8 ipek baskı
- Net sınıfı sistemi (E11) ve IPC-2221'in oraya taşınması
- Vendor BOM/CPL varyantları, O10
- Montaj deliği / test noktası üretimi

**P3 — ürün yüzeyi**
- FE1–FE7
- Manifest ve "doğrulandı" rozeti
- O12 determinizm CI'da

---

## 10. Repoda doğrulanacaklar

Kaynak koda erişemediğim için aşağıdakiler **iddia değil, kontrol listesi**:

1. `packages/pcb-core/src/adapter.ts` — footprint string'i MPN'in paket alanından mı, komponent tipinden mi seçiliyor?
2. `circuit-json-to-kicad` çıktısında `(attr smd)` yazılıyor mu?
3. IPC-2221 hesabı nerede yapılıyor, `k` katsayısı sabit mi?
4. Route sonrası hiçbir genişlik denetimi var mı?
5. Zone yazımında `thermal_gap` / `thermal_bridge_width` set ediliyor mu?
6. PnP writer'ı hangi origin'i kullanıyor? Gerber writer'ı ile aynı sabitten mi besleniyor?
7. `fab-profile.ts`'de stackup alanı var mı, yoksa sadece design rules mı?
8. Pin seviyesi izomorfizm denetimi gerçekten koşuyor mu, yoksa planlanmış mı?
9. `crates/pcb-placement-rs` determinizm disiplini (sabit adım, trigonometri yasağı) koda geçmiş mi?
10. `scripts/layout-sweep.mjs` ve ATmega fikstürü — yield kapıları bugün koşuyor mu?

---

## Ek A — Flux referans ölçümleri

Karşılaştırma yaparken kullanılacak ham değerler.

| Parametre | Flux değeri |
|---|---|
| Kart | 160 × 100 mm, dikdörtgen, köşe yarıçapı 0 |
| Stackup | 4 katman, toplam 1.299358 mm, `PROPOSED` |
| Dielektrik | 3 × 0.379786 mm (= 15 mil), FR4, Er 4.50, tanδ 0.020 |
| Bakır | 4 × 0.035 mm (1 oz), maske 0.010 mm |
| İz genişliği | 0.15 mm (tüm netler) |
| Via | pad 0.6 mm / drill 0.3 mm → annular 0.15 mm |
| THT delikler | 1.0 mm ve 1.1 mm, pad 1.7 × 2.0 mm |
| Pour clearance | 0.5 mm sabit |
| Stitching | 15 mm ızgara, 58 via, komponent çakışmasında atlanıyor |
| Maske genişlemesi | 0 |
| Pasta | bakırla birebir (%100), THT dahil |
| Board inner margin | 400 µm |
| Auto layout gravity | 0.5 |
| Toolchain | KiCad 9.0.9-9.0.9~ubuntu22.04.1, `/tmp/input.kicad_pcb` |
| Katman adları | KiCad seti (F.Cu, In1.Cu, In2.Cu, B.Cu, Eco1.User, Dwgs.User, Margin, F.CrtYd …) |
| UI stackup terminolojisi | Altium seti (Top Overlay, Mid-Layer 1/2, Top Solder) |

### Ek A.1 — U1 pour boşluğu (F2'nin ham verisi)

```
Üst pin sırası boşluğu : x 41.110 … 43.390   y −75.590 … −77.100
Alt pin sırası boşluğu : x 41.610 … 43.390   y −77.450 … −78.960
Pad'ler (0.28 × 0.51 mm, 0.5 mm pitch):
  üst : PG 41.75 · SW 42.25 · VOS 42.75 · FB 43.25   (y −76.35)
  alt : PGND 41.75 · VIN 42.25 · EN 42.75 · AGND 43.25 (y −78.21)
EP  : 1.6 × 0.9 mm @ (42.50, −77.28)
Pour'un EP'ye ulaştığı boyun: y −77.100 … −77.450  →  0.35 mm
Sonuç: FB, PGND, AGND tamamen boşluk içinde; U1'in GND'ye tek bağı EP.
```