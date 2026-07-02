# PCB Faz 1 — Dosya-Seviyesi Uygulama Planı (ONAYLANDI — brief §10 koşullarıyla)

> **Onay durumu:** çapraz-doğrulamayla onaylandı (2 Tem 2026 akşam). 4 koşul + küçükler aşağıya işlendi;
> tam gerekçe PCB_BRIEF.md §10'da. İnşa `feat/pcb-core-phase1` branch'inde.

> Kapsam: **adaptör + hat** (brief §6 Faz 1). Kütüphane + script-harness. API/worker (LayoutJob) Faz 2'de,
> IPC-2221 genişlikleri Faz 3'te (hook'u burada hazırlanır). Runtime dondurması korunur: design-core /
> multi-candidate / mevcut API'ye DOKUNULMAZ. %100 API-free (LLM yok). Efor: ~1 hafta.

## 0. Yerleşim kararı: yeni paket `packages/pcb-core`

`@circuit-forge/pcb-core` — eda-core'a KARIŞTIRILMAZ. Gerekçe: tscircuit ekosistemi genç/hareketli
(0.0.x sürümler, bugün bile commit alıyor); 391-testlik, savaş görmüş eda-core'un bağımlılık ağacına
sokulmaz. pcb-core, eda-core'dan yalnız TİP alır (CircuitJson/Component/UiJson).

**Pinli bağımlılıklar (V1 raporundan, exact):** `@tscircuit/eval` (MIT), `circuit-json-to-kicad@0.0.156`
(MIT), `circuit-json-to-gerber@0.0.78` (⚠ lisans dosyasız — upstream issue açılacak, karar: netleşene
kadar yalnız worker-side kullanım, core'a re-export edilmez), `dsn-converter@0.0.91`.

## 1. Dosyalar

```
packages/pcb-core/
  src/
    footprints.ts      # küratörlü kılıf haritası + resolveFootprint() (LED kuralı: diode + model-ref led_*)
    layoutability.ts   # sınıflandırma + diagnostics; excluded=FAIL default (allowPartial opt-in) + completeness
    adapter.ts         # CircuitJson(+UiJson) → tscircuit JSX kod üretimi (NC beyanı dahil)
    parity.ts          # KOŞUL 1: pin-seviyesi izomorfizm denetimi + semantik-çapa (adapter-haritasından bağımsız)
    fab-profile.ts     # JLC-uyumlu kurallar tek-kaynak + GND zone injection + perNetMinWidth hook (Faz-3)
    route.ts           # exportDsn() + mergeSes() saf fonksiyonlar (golden SES fixture'la test)
    outputs.ts         # gerber/drill + .kicad_pcb + BOM CSV + PnP CSV paketleme
    index.ts           # layoutCircuit(circuit, ui?, opts?) — opts.router: 'fast'|'quality' imzada
  __fixtures__/        # dense.circuit.json + dense.dsn + dense.ses (bugünkü GERÇEK koşudan kurtarıldı)
  __tests__/           # unit + integration (gerçek eval/route, network-free: local router'a explicit pin)
scripts/layout-check.mjs   # 3 fixture devre uçtan uca + (Docker varsa) kicad-cli 10 DRC → pnpm test:layout
```

## 1b. Onay koşullarının uygulanışı (brief §10)
1. **parity.ts (kritik):** eval sonrası tscircuit source_port→net üyeliği ↔ bizim pinId→net üyeliği
   **pin-seviyesi izomorfizm** (partition eşitliği; net ADLARI değil kümeler). Paylaşılan-kader riskine karşı
   polarize/çok-pinli tiplerde (diode/bjt/mosfet/led) tscircuit'in SEMANTİK port adları (.anode/.collector)
   üstünden haritadan-bağımsız çapa assert'leri. layoutCircuit içinde kalıcı diagnostic + integration assert.
2. **Excluded=FAIL:** load-bearing exclusion (transformer/tline/vcvs/vccs/bsource/logic_*/dff…) default
   HATA; `opts.allowPartial=true` ile warn'a düşer; sonuç `completeness: 'full'|'partial'`; üretilebilir-paket
   dili yalnız `full`. Kaynak→konnektör exclusion DEĞİL (fiziksel yorum).
3. **NC politikası:** footprint pinleri > eşlenen portlar → kalan pinler NC olarak beyan (diagnostics info) —
   OPAMPGEN(5 port)→SOIC-8(8 pin) vakası fixture (c)'de.
4. **LED:** `type==='diode' && model?.match(/^led/i)` → `<led>`; değilse `<diode>`.
5. **Küçükler:** `opts.router` imzada ('quality' Faz-2'de doldurulur, şimdilik 'fast'=tscircuit local);
   local-router explicit pin (network-free determinizm); golden SES fixture mergeSes testinde; annular
   default **0.15mm** (raporla tutarlılık notu: 0.1 minimum fab siniri, 0.15 bizim güvenli default).

## 2. Haritalama tablosu (ampirik katalog probuna dayalı — bugün doğrulandı)

| Bizim tip | tscircuit | Not |
|---|---|---|
| resistor / capacitor / inductor | `<resistor/capacitor/inductor>` | default 0603; `properties.size` ile 0402/0805/1206; `component.footprint` override HER ZAMAN kazanır (alan şemada zaten var) |
| diode / zener | `<diode>` | SOD-123 default |
| led (properties.led'li diode?) → | `<led>` | 0603 default |
| bjt | `<transistor>` | SOT-23 default; TO-92 properties ile |
| mosfet | `<mosfet>` | SOT-23 |
| jfet | `<chip>` fallback | katalogda YOK (bugünkü prob); SOT-23 pad'li chip |
| subckt (op-amp vb.) | `<chip footprint="soicN">` + **pinId→pinN haritası** | ModelDef.ports sırası = pin1..pinN; pinLabels prop. Adaptörün asıl işi bu |
| switch | `<switch>` | katalogda var |
| voltage_source / current_source | `<pinheader>` (2-pin) **politika: connectorize** | fiziksel kartta kaynak = konnektör; diagnostics'e not düşülür |
| ground | net-only | net adı "GND"ye normalize (isGround) |
| transformer / tline / vcvs / vccs / bsource | **v1 EXCLUDED** | sim-primitifi, fiziksel eşleniği tartışmalı; diagnostics warn + karttan hariç (dürüst rapor) |
| logic_* / dff / jkff / tff / dlatch / tristate | **v1 EXCLUDED** | XSPICE sim-primitifi — gerçek kartta 74xx IC'ye çevrimi ayrı iş (v2 adayı); diagnostics warn |
| generic (footprint'li) | `<chip>` | katalog parçası; footprint zorunlu, yoksa excluded+warn |

## 3. Modül sözleşmeleri

- **`layoutability.ts`:** her komponenti `direct | chip-fallback | connectorized | net-only | excluded`
  olarak sınıflar; en az 1 layoutable yoksa hata; sonuç `diagnostics[]` (code+severity+message — ERC
  formatının aynısı, frontend'e hazır).
- **`adapter.ts`:** JSX string üretir (PoC'ta kanıtlanan yol) → `runTscircuitCode`. Designator/value/
  rotation korunur; pcbX/pcbY **UiJson.positions'tan ölçekli seed** (yoksa deterministik ızgara);
  değerler sanitize edilir (şema-doğrulanmış olsa da JSX injection'a karşı). Net bağlantısı: netin pin
  listesi `<trace from to>` zinciriyle (PoC'ta net-birleşimi doğrulandı; integration testte büyük-net
  vakası var).
- **`fab-profile.ts`:** tek doğruluk kaynağı ilkesi — profil (trace ≥0.2mm, clearance ≥0.2, via drill
  0.3/annular ≥0.15) hem tscircuit autorouter config'ine basılır hem `.kicad_pcb` setup/design-rules
  bloğuna yazılır → noterin denetlediği kurallar = bizim bastıklarımız (V-raporu 26/51-ihlal dersi).
  `perNetMinWidth?: Record<netId, mm>` parametresi İMZADA — Faz 3 (IPC-2221) doldurur. GND zone
  injection (V9'da kanıtlanan s-expr yolu) `pour: boolean` bayrağıyla; **default: GND neti algılanırsa AÇIK**.
- **`route.ts`:** default routing eval sırasında (tscircuit). `exportDsn(cj)` / `mergeSes(cj, ses)` saf
  fonksiyonlar — freerouting EXEC'i yok (o Faz-2 worker işi; script-harness Docker'la koşar).
  Router kıyası bulgusu gereği: kalite modu (freerouting) Faz-2'de birinci sınıf seçenek olacak.
- **`outputs.ts`:** gerbers+drill, kicad_pcb (fab-rules+zone enjekteli), **BOM CSV** (designator/value/
  footprint/mpn/manufacturer — veriler şemada zaten var), **PnP CSV** (pcb_component x/y/rotation/layer).
- **`index.ts`:** `layoutCircuit(circuit, ui?, opts?) → { tscircuitJson, outputs, diagnostics, stats{traces,vias,unrouted,durationMs} }`

## 4. Test stratejisi (mock'suz felsefe)

- **Unit (jest):** footprint çözümü/override; layoutability sınıflandırma matrisi (her tip); adapter JSX
  üretimi (yapısal assertion — subckt pin sırası, GND normalize, sanitize); fab-profile injection
  (.kicad_pcb'de kural bloğu + zone); BOM/PnP içerik doğruluğu.
- **Integration (jest, GERÇEK eval+route — LLM'siz, ngspice'sız):** 3 fixture: (a) divider+LED,
  (b) CE amplifikatör (BJT+pasifler), (c) subckt op-amp'lı karışık devre. Assert: unrouted=0, gerber
  katman seti tam, kicad_pcb s-expr parse olur, **tracespace bağımsız parse** yeşil. (PoC ~3-6s/devre →
  CI'da taşınabilir.)
- **Script-harness (`pnpm test:layout`, Docker'lı, CI-dışı manuel — coverage-matrix kalıbı):** 3 fixture
  uçtan uca + `kicad-cli 10 pcb drc --refill-zones --exit-code-violations` + render.png üretimi.

## 5. Bilinçli Faz-1-dışı
LayoutJob/API/worker + freerouting/kicad-cli container exec (Faz 2) · IPC-2221 net-genişlik (Faz 3;
hook hazır) · GLB/render ürün-içi üretimi (Faz 2; harness'ta var) · komponent 3D model-ref enjeksiyonu
(Faz 2 notu) · frontend viewer (FE sprinti) · digital→74xx çevirisi (v2 adayı).

## 6. Guardrail'ler (karar gereği)
Bakiye dönerse S4→SMOKE→N=4 bu işi KESER (kısa validasyonlar) · kullanıcıya açılış frontend'le ·
branch: `feat/pcb-core-phase1`, main'e PR'la; design-core/API'ye sıfır dokunuş.
