# LayoutJob Planı — PCB'yi worker'a bağlama (motoru ürün özelliğine çevirmek)

**Tarih:** 7 Temmuz 2026 · **Sürüm:** v2 (3-denetçili adversarial review'den geçti: kontrat / infra /
kod-tutarlılık — gerçek 3 yanlış varsayım yakalandı, hepsi işlendi) · **Durum:** ✅ **UYGULANDI VE SEVK EDİLDİ**
**Referans:** Flux.ai PCB editör ekranı (founder paylaştı) — hedef deneyim; kontrat ona göre kilitli.
**Önkoşul bilgi:** yok.

---

## 0. Bu ne, ne DEĞİL

**Ne:** pcb-core motorunu (hazır, CI-korumalı) worker'da çalışan bir **iş (job)** yapmak — kullanıcı
"devremi PCB yap" deyince arka planda üretip sonucu döndürmek. Simülasyon işinin (bugün çalışan
`simulation`/`design` BullMQ processor'ları) PCB versiyonu.

**Ne DEĞİL:** Frontend'i yapmak. Bu plan, frontend geldiğinde **sıfır backend reworkü** ile takılabilmesi
için **veri sözleşmesini** kilitler ve motoru worker'da koşturur.

> ## ⚠️ BU BİR TARİHSEL PLAN BELGESİDİR (7 Tem 2026)
>
> **Plandaki her şey yapıldı ve sevk edildi.** Aşağıdaki metin, işin *başlamadan önceki* niyetini kaydeder;
> bugünkü durumu değil. Özellikle şu ikisi artık geçerli değil:
>
> - **"LayoutJob için sıfır kod"** — `/layouts` controller'ı (POST 202 + liste + detay), `LayoutService`,
>   `pcb-layout` kuyruğu, `apps/pcb-worker` servisi ve `LayoutJob` Prisma modeli hepsi çalışıyor.
> - **§2'de kilitlenen ÇIKTI sözleşmesi** uygulanırken değişti (durum enum'u, katman adları, sonuç blob'unun
>   alanları). Sevk edilen sözleşme için **[FRONTEND_PCB_EDITOR_BRIEF.md](FRONTEND_PCB_EDITOR_BRIEF.md)** ve
>   **[docs/API.md](docs/API.md) §3.16** yetkilidir — burada okuduğun şekiller değil.
>
> Belgeyi silmiyoruz: hangi kararların neden alındığını ve review'in hangi iyimser varsayımları düzelttiğini
> kaydediyor. Ama **bir şeyin nasıl çağrılacağını buradan öğrenme.**

> **Review'in düzelttiği 3 iyimser varsayım (dürüstlük):**
> 1. **Airwires "soup'u şekillendir" DEĞİL.** Quality/freerouting yolunda (sevk edilen yol) bakır izler,
>    hangi bağlantının route edildiğini kaybediyor (mergeSes splice sonrası port-linkage düşüyor). Airwire,
>    KiCad DRC'nin **`unconnected_items`**'ından türetilmeli → **notary seam'i genişletmek gerek** (bugün
>    boolean döndürüyor, veriyi atıyor). Yeni iş, reshaping değil.
> 2. **`pours` vektör-poligon olarak yok.** GND pour, .kicad_pcb'ye **bbox metni** olarak enjekte ediliyor,
>    gerçek dökülmüş bakır sadece export anında Gerber'da raster olarak oluşuyor. Kontrat düzeltildi.
> 3. **GLB motor tarafından "zaten üretilmiyor".** `layoutCircuit` GLB döndürmez; GLB **ayrı bir
>    kicad-cli export adımı** (gen-gallery'de). LayoutJob bu adımı da koşacak. "%85 hazır" iddiası abartıydı.

---

## 1. Akış (mutfak benzetmesi)

```
Kullanıcı → API (garson) → "pcb-layout" kuyruğu → pcb-worker (aşçı) → S3'e GLB/Gerber + Prisma'ya durum → kullanıcı indirir
                                                        │
              pcb-core (saf motor) + native freerouting.jar + kicad-cli (route + DRC + GLB export)
```

`worker-sim`'in ngspice deseninin birebir aynısı (BullMQ Worker + Redis + Prisma) — ama tooling ve base-image farklı.

---

## 2. SÖZLEŞME (planın kalbi) — review'e göre düzeltildi

### GİRDİ
```ts
interface LayoutJobInput {
  circuit: CircuitJson;
  placer?: 'grid' | 'auto';                 // Flux "Auto-Layout"; default grid
  placements?: Record<id, {x,y,rotation}>;  // kullanıcı elle taşıdıysa (direkt-mm)
  fabProfile?: FabProfile;                    // Flux "Rules"
  netCurrentsA?: Record<net, number>;
  // v2: lockedTraces[], keepouts[] (ANTENNA_KEEPOUT), componentOverrides[]
}
```

### ÇIKTI (her eleman **stable id** taşır — cross-probe + Objects-paneli seçimi için)
```ts
interface LayoutJobResult {
  status: 'done' | 'failed' | 'partial';
  layout: {
    board:   { widthMm, heightMm, outline: Pt[] };            // rect board'ta outline YOK → dikdörtgen SENTEZLENİR
    layers:  [{ name: 'F.Cu' }, { name: 'B.Cu' }];
    components: [{ id /*=OUR CircuitJson id*/, designator, x, y, rotation,
                  footprint, bodyWmm, bodyHmm, courtyard: Pt[] /*iki soup şeklinden normalize*/, layer }];
    pads:   [{ id, componentId, pinId /*schematic cross-probe*/, net|null, x, y,
               layer, shape, wMm, hMm, drillMm? /*THT plated-hole dahil*/ }];
    traces: [{ id, net, segments: [{ layer, widthMm, points: Pt[] }] /*iz katman değiştirebilir*/ }];
    vias:   [{ id, x, y, drillMm, fromLayer, toLayer, net }];
    pours:  [{ net, layer, region: Pt[] /*enjekte bbox — DÖKÜLMÜŞ şekil DEĞİL; gerçek fill Gerber/3D'de*/, present: true }];
    airwires: [{ net, from: Pt, to: Pt }];   // KiCad unconnected_items'tan (notary seam'i döndürecek) — route EDİLMEMİŞ
  };
  render: { glbUrl };                          // kicad-cli export adımı üretir → S3
  manufacturing: { gerbersUrl, drillUrl, bomCsv, pnpCsv }; // Gerber/drill → S3; küçük CSV inline
  checks: { drc: [{ category, type, severity, message, refs, location }]; summary: {errors,warnings,info} };
  diagnostics: LayoutDiagnostic[];             // bizim PCB0xx notları
}
```

### Flux ekranı ↔ kontrat (DÜZELTİLMİŞ durum sütunu)
| Flux'ta | Kontrat alanı | Durum |
|---|---|---|
| Files/Schematic/PCB | `circuit` (tek kaynak) | ✅ var |
| 2D / 3D toggle | `layout` + `render.glbUrl` | 🟡 GLB ayrı export adımı (motor üretmiyor) |
| Top/Layer seçici | `layers[]` + eleman `layer` | ✅ soup'ta var |
| **Airwires • 62** | `layout.airwires[]` | ❌→🟡 **notary seam değişikliği** (KiCad unconnected_items) |
| Overlapping/Dangling/Vias... | `checks.drc[]` | 🟡 DRC var, kategorize + konumlar parse edilecek |
| Objects paneli | eleman ağacı + **stable id'ler** | 🟡 id'ler soup'ta var, kontrata eklendi |
| pad→şema cross-probe | `pads[].pinId` | 🟡 join ile türetilir (eklendi) |
| Rules paneli | `fabProfile` | ✅ var |
| **Library (parça)** | TME (sourcing) + tscircuit footprint (geometri) | ⚠ **AYRI şeyler** — "böz→geometri" birleşik kütüphane v2, "entegre" değildi |
| Auto-Layout (Beta) | `placer:'auto'` | ✅ var |
| pours (dökülmüş bakır) | `pours[].region` (bbox) | 🟡 gerçek fill vektör değil (Gerber raster) |
| ANTENNA_KEEPOUT / Overrides | girdi | ❌ v2 |

**Net iş:** çoğu koordinat soup'ta VAR ama **düz alan değil, çok-adımlı join** (net = port→trace→net;
designator = source_component; footprint = cad_component — bunları placement-bridge.ts zaten yapıyor).
Airwire + pours + GLB **ek adımlar**, reshaping değil.

---

## 3. Worker infra (review'in en sert vurduğu yer — "birkaç gün"ün asıl sebebi)

**❌ "worker-sim Dockerfile'ını kopyala + KiCad ekle" ÇALIŞMAZ:** worker-sim `node:20-alpine` tabanlı;
**kicad-cli'nin Alpine/musl paketi YOK** (yalnız Debian/Ubuntu/AppImage). Ayrıca GLB export, KiCad 3D
model kütüphanesinin `/usr/share/kicad/3dmodels/` (sabit yol) mevcut olmasını ister — yani **tam KiCad
kurulumu** gerekir, sadece cli değil.

**✅ ÖNERİ: pcb-worker imajını `kicad/kicad:10.0-full`'dan türet** (zaten tüm pipeline'ı bununla doğruladık;
Ubuntu tabanlı, kicad-cli + 3D modeller `/usr/share/kicad/3dmodels`'te hazır) → üzerine **Node 22** (nodesource)
+ **Java 21 + AWT font native lib'leri** (freerouting.jar headless — freerouting.mjs kanıtlıyor batch modu
gerçek) + freerouting.jar + bizim derlenmiş kodumuz. Büyük imaj (~3GB) ama **doğru ve doğrulanmış**.

**Depolama (düzeltme):** sim işleri sonucu **Prisma'ya inline JSON** yazıyor — GLB (~1.5MB) + Gerber buna
sığmaz/uygun değil. PCB çıktıları → **S3 blob** (stack'te MinIO/S3 var), `glbUrl`/`gerbersUrl` = presigned
URL; iş durumu/metadata → Prisma (sim gibi).

**Bootstrap (düzeltme):** `worker-sim/main.ts` olduğu gibi kopyalanamaz — llm-core, ngspice sandbox/bwrap
preflight, telemetry'yi koşulsuz kuruyor. pcb-worker **kırpılmış** bir bootstrap ister (bunlar YOK, sadece
BullMQ Worker + Redis + Prisma + S3 + pcb-core).

**pcb-core saf kalır:** native runner yazarım (`java -jar freerouting.jar …`, `kicad-cli …` doğrudan) —
`scripts/lib/`'deki (repo kökünde, pcb-core içinde DEĞİL) Docker-run runner'ların muadili; layoutCircuit
zaten `freeroute`/`notaryDrc` enjekte alıyor → native runner drop-in.

**Node bölünmesi (düzeltme):** worker-sim (Node 20) + pcb-worker (Node 22) tek pnpm workspace + tek lockfile
paylaşıyor; paylaşılan paketler ES2022'ye derleniyor (ikisinde de çalışır — sorun derleme değil). Dikkat:
her iki Dockerfile `packages/`'ı kopyalıyor; pcb-worker'ın Node-22 base'i + kendi bağımlılık kurulumu ayrı olmalı.

---

## 4. Dilimler (her biri kapılı)

| # | İş | Kapı |
|---|---|---|
| M1 | Kontrat tipleri + pcb-core `shapeLayoutResult(soup)` (join'ler: net/designator/footprint, eleman-id'leri, courtyard normalize, outline sentez, THT pad, trace-segment) — SAF + unit test | soup→kontrat testleri yeşil |
| M1b | **notary seam genişlet**: `notaryDrc` boolean yerine parsed `{clean, unconnected_items[], violations[]}` döndürsün (kicad-drc.mjs) → airwires + kategorize DRC türetilir | airwire/DRC birim testleri yeşil; mevcut çağıranlar uyarlandı |
| M2 ✅ | **native runner'lar** (freerouting.jar + kicad-cli, Docker'sız) + GLB export + `pcb-runtime` imajı | native runner'lar gerçek imajda golden fixture'lara karşı doğrulandı |
| M3 | **pcb-worker servisi**: `pcb-runtime` tabanına pcb-core+deps bake + kırpılmış BullMQ bootstrap + S3 blob + Prisma durum | worker imajı build olur, **native layoutCircuit(quality) uçtan uca DRC-temiz+GLB** koşar |
| M4 | API: `POST /layouts` (enqueue) + `GET /layouts/:id` + entegrasyon testi | API→kuyruk→worker→S3/Prisma→fetch e2e yeşil |
| M5 (FE ile) | airwire ratsnest render, keepouts, lockedTraces, overrides, birleşik Library | FE geldiğinde |

**M1–M2 LLM'siz + Docker'lı-yerel** (bugün başlanabilir). **M3–M4 infra** (imaj + S3 + deploy).

**M3b+M4 durum (7 Tem 2026):** `apps/pcb-worker` (@circuitforge/pcb-worker) BullMQ servisi (config/logger/prisma/s3 worker-sim'den mirror; native runner'lar TS'e port; processor = atomik QUEUED→RUNNING claim + native `layoutCircuit(quality)` + shapeLayoutResult + drcReport→checks/airwires + injectModels + exportGlb → GLB & manufacturing.json S3'e, satıra key) + API `layout/` modülü (`POST /layouts` 202, `GET /layouts/:id` presigned URL'ler; 'pcb-layout' queue registerQueueAsync attempts:1) + Prisma `LayoutJob` model+enum+migration. Docker: `docker/pcb-worker/Dockerfile` servis imajı (builder pnpm-deploy + **runtime prisma generate** — pnpm-deploy generated `.prisma/client`'i bundle'a katmıyor, şema worker-dizini-altında olmalı ki proje-kökü doğru çıkarılsın) + `docker-compose.yml` pcb-worker servisi (volume-mount YOK, self-contained bundle). **CANLI E2E KANITLANDI** (compose pg+redis+minio): enqueue → worker → QUEUED→RUNNING→SUCCEEDED ~30s, satırda drcClean=true/traces=11/parity=10, MinIO'da board.glb 243KB + manufacturing.json 27KB gerçekten mevcut. pcb-worker `tsc` + full API `tsc --noEmit` temiz. KALAN: API HTTP yolu (POST/GET) canlı — JWT auth kurulumu ister; kod typecheck-temiz + design-job desenini birebir izliyor (kuyruk kontratı worker e2e ile aynı, kanıtlı).

**M3a durum (7 Tem 2026):** `docker/pcb-worker/Dockerfile` (multi-stage: builder `pnpm deploy` ile symlink-siz self-contained pcb-core → runtime `FROM pcb-runtime` + baked pcb-core + native runner'lar) + `.dockerignore` (kritik: `**/*.tsbuildinfo` — host'un stale incremental cache'i imaja girince composite `tsc` emit'i atlıyor, eda-core `index.js` üretmiyor, pcb-core TS2307+implicit-any kaskadı; kök-neden düzeltildi). `scripts/verify-native-composition.mjs` imajın İÇİNDE tam `layoutCircuit(router:'quality')`'i native runner'larla koştu — **2 devre uçtan uca kanıtlandı:** divider-led (freerouting 11 iz, parity 10/10, native DRC TEMİZ, 5 gövde, GLB 1.4×) + ce-amp (23 iz/1 via, 17/17, TEMİZ, 8 gövde, 1.4×). Native freerouting SES splice-edilebilir + native DRC oracle accept/reject döngüsünü sürüyor — kanıtlı.

**M2 durum (7 Tem 2026):** `scripts/lib/{freerouting,kicad}-native.mjs` (Docker `run` sarmalayıcısı yok, binary doğrudan; mevcut Docker-runner'larla birebir argüman-paritesi) + `docker/pcb-runtime/Dockerfile` (kicad:10.0-full **digest-pinli** + Temurin-25 JRE **+ jar ikisi de pinlenmiş freerouting imajından `COPY --from`** → jar↔JRE versiyon-eşleşme garantisi; Node 22 nodesource) + `scripts/verify-native-pipeline.mjs`. Gerçek imajda doğrulandı: freerouting native → 54 wire/20 net (golden ile birebir), notaryDrc temiz→true / kirli→false (exit-5 reject dalı), drcReport temiz 0/0 / kirli 11-ihlal, exportGlb geçerli GLB gövde-çözümü 1.5×. 3-lens adversarial review (17 bulgu→doğrulananlar) → verify harness sertleştirildi (gerçek-bakır floor, zorunlu+fatal anti-rubber-stamp differential, reject-path). **Tam native `layoutCircuit(quality)` uçtan uca kanıtı M3'e ait** (worker imajı pcb-core+deps bake edince; Windows-pnpm-symlink Linux'ta çözülmüyor).

**Native-runner harness’ları KALDIRILDI (27 Tem 2026).** Yukarıdaki M2/M3a kanıtları tarihsel kayıttır; onları üreten `scripts/verify-native-{pipeline,composition}.mjs` ve `scripts/lib/{kicad,freerouting}-native.mjs` artık repoda YOK.

İki sebep:

1. **Çift uygulama.** Üretim koşucularıyla (`apps/pcb-worker/src/runners/{kicad,freerouting}.ts`) aynı işi yapan ikinci bir kopyaydılar ve `kicad-native.mjs`, üretimdeki fail-CLOSED davranıştan fail-OPEN yönde ayrışmıştı. Üretim dosyası kendini "bunun TS portu" diye tanımladığı için "referans uygulamaya dön" hamlesi, DRC’nin hiç denetlemediği bir kartı üretilebilir damgalatabilirdi.
2. **Zaten koşturulamıyorlardı.** Hiçbir workflow, `package.json` script’i veya Dockerfile onları çağırmıyordu; `verify-native-composition.mjs`’in belgelenen çalıştırma yolu (`docker run pcb-worker:local node /app/runners/...`) imajın hiç oluşturmadığı bir dizini gösteriyor.

Yerlerini birim testleri aldı: `apps/pcb-worker/src/runners/kicad.spec.ts` (DRC oracle, rapor şeması, notary memo, gerber teslimi — mutasyonla doğrulandı) ve `apps/pcb-worker/src/layout/processor.spec.ts` (teslimat geçidi: DRC’nin reddettiği kart indirilebilir paket üretemez). Bunlar `ci.yml`’de her PR’da koşar — harness’lar hiç koşmuyordu.

**Dürüst kalan boşluk:** pcb-worker İMAJINI uçtan uca doğrulayan otomatik bir kontrol yok. İmaj derlemesi (~3GB, kicad-full tabanlı) PR başına yapılmayacak kadar pahalı olduğu için bilinçli olarak kabul edildi; imaj seviyesinde bir kırılma dağıtım anında görülür, merge anında değil.
---

## 5. Dürüst riskler
- **Airwires seam değişikliği** (M1b): `notaryDrc` imzası değişiyor → mevcut çağıranlar (layout-check, gen-gallery, index.ts margin-retry) uyarlanmalı. Sınırlı ama gerçek dokunuş.
- **pcb-worker imajı ~3GB** (kicad-full tabanlı) → build/registry maliyeti + deploy süresi; ayrı servis izole eder.
- ~~**Java 21**~~ → **UYGULAMADA DEĞİŞTİ:** Java 21 çalışmıyor. Üretim imajı, JRE'yi VE jar'ı **pinlenmiş freerouting imajından `COPY --from`** ile alıyor (Temurin) — böylece jar↔JRE sürüm uyumu garanti; ayrı bir JRE kurup sürüm eşleştirmeye çalışmak kırılgan çıktı. AWT font kütüphaneleri hâlâ şart.
- **KiCad 3D model yolu sabit** (`/usr/share/kicad/3dmodels`) — kicad-full base'de var, başka base'de GLB çuvallar.
- **S3 depolama şart** (GLB/Gerber büyük) — inline-JSON deseni yetmez; presigned-URL akışı kurulur.
- **PCB işi yavaş** (10–120sn) → kuyruk eşzamanlılığı + timeout + kaynak sınırı (sim'deki semafor deseni).
- **Node 22 zorunlu** (iterator-helper) → pcb-worker Node 22; worker-sim (Node 20) dokunulmaz.
- **Frontend tüketicisi yok** → API/test'ten kullanılır, son-kullanıcıya görünmez (FE'ye kadar). Değer "gerçek ama backend-only".
- **Kapsam dışı v1:** keepout, locked-trace, component-override, çift-yüz, gerçek-pour-poligonu, birleşik Library (hepsi v2, sözleşmede yer ayrıldı).

## 6. Founder SSS
- **Frontend'i kırar mı?** Hayır — kontrat FE ihtiyacına + cross-probe id'lerine göre kilitli; FE geldiğinde takılır, backend reworkü olmaz.
- **Elle sürükleme/route çalışır mı?** Kontrat destekliyor (`placements` girdisi + `courtyard`/`airwires`/`pinId` çıktısı); etkileşim FE işi, bu veriye dayanır.
- **Mevcut sim worker'ı etkilenir mi?** Hayır — ayrı `pcb-worker` servisi; worker-sim'e dokunulmaz.
- **"Birkaç gün" gerçekçi mi?** M1–M2 (motor tarafı, kod) ~2 gün; M3–M4 (imaj + S3 + API + e2e) infra'ya bağlı ~2-3 gün. Toplam ~4-5 gün, dilimler kapılı.
