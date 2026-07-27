# Circuit Forge — Production Readiness İncelemesi

## Amaç ve kapsam

Bu belge, ürün sahibinin yetkilendirdiği kendi yazılımına ait savunma, ürün kalitesi ve üretim hazırlığı incelemesidir. Güvenlik risklerine ilişkin hassas teknik ayrıntılar, yeniden üretim adımları, örnek girdiler, kimlik bilgisi bilgileri ve saldırı senaryoları özellikle çıkarılmıştır. Değerlendirme yalnızca risklerin önceliklendirilmesi ve iyileştirme planı için kullanılmalıdır; yeni saldırı yöntemi, çalıştırılabilir örnek veya güvenlik kontrolünü aşma talep edilmemektedir.

Başka bir modele verirken şu talimat kullanılabilir:

> Aşağıdaki yetkili ve savunma amaçlı production-readiness incelemesini ürün olgunluğu açısından değerlendir. Yeni saldırı yolu, çalıştırılabilir örnek, komut veya güvenlik kontrolünü aşma prosedürü üretme. Bulguları P0–P3 önceliklendir; her biri için iş etkisi, güvenli düzeltme yaklaşımı, doğrulama testi ve production exit criterion öner.

## Net hüküm

Circuit Forge bugün production-ready değildir: **NO-GO**.

Doğru konumlandırma, zorunlu mühendis incelemesiyle kullanılan bir **internal engineering alpha/beta** ürünüdür. “Verified circuit”, “manufacturing-ready” ve otomatik üretim dosyası teslimi gibi iddialar için bazı temel güvenilirlik kapıları henüz tamamlanmamıştır.

| Alan                                | Değerlendirme                     |
| ----------------------------------- | --------------------------------- |
| ngspice ve EDA çekirdeği            | Güçlü                             |
| API ve temel iş akışları            | Çalışıyor                         |
| AI doğrulama semantiği              | Kritik iyileştirme gerekli        |
| PCB üretim zinciri                  | Kritik iyileştirme gerekli        |
| Platform izolasyonu ve operasyonlar | Production sertleştirmesi gerekli |
| Frontend ve editör deneyimi         | Henüz ürünleşmemiş                |

## Doğrulanan güçlü yönler

- Altı TypeScript workspace derlendi; dokuz typecheck görevi geçti.
- Toplam 1.201 otomatik test geçti; 19 opt-in canlı test çalıştırılmadı.
- Native ngspice 41 üzerinde 83/83 kapsam matrisi, 51/51 fizik ve sınır testi, 200/200 pairwise kombinasyon ve 150 seeded fuzz vakası başarıyla tamamlandı.
- Production image içindeki ngspice 45.2 üzerinde aynı 83+51 doğrulama tekrar geçti.
- İzole container smoke simülasyonu beklenen 2,5 V sonucunu verdi.
- Gerçek freerouting 2.2.4 ve KiCad 10 ile üç PCB fixture kalite rotası ve DRC kontrolünü geçti.
- Gerçek HTTP → queue → worker → database/object-storage akışı; kullanıcı, organizasyon, proje, version, simülasyon ve PCB üretimi boyunca başarıyla tamamlandı.
- PCB uçtan uca testinde DRC-clean sonuç, GLB ve manufacturing artifact erişimi doğrulandı.
- Gerçek TME servis testlerinin 11/12’si geçti. Tek kırmızı sonuç, Zener desteği geliştirilirken geride kalmış test beklentisinden kaynaklanıyor.
- API/worker ayrımı, terminal job durumları, gerçek simülatör regresyonları ve production ngspice sürüm kontrolü iyi mühendislik temelleridir.

## Production blocker’ları

### 1. AI doğrulaması kullanıcı şartına değişmez biçimde bağlı değil

AI bugün ölçüm kriterlerini kendisi oluşturabiliyor ve yine kendi oluşturduğu kriterlere göre başarı kararı verebiliyor. Kullanıcının orijinal gereksinimi ile ölçülen kabul kriteri arasında bağımsız, typed ve değişmez bir bağ bulunmuyor.

Ek sorunlar:

- ERC sonuçları bütün AI design-loop kararlarında zorunlu bir hard gate değil.
- Boş kabul kriteriyle çalışan bir devre “pass” sonucuna ulaşabiliyor.
- Asenkron tasarım yolu gerçek katalog grounding akışını kullanmıyor.
- Bazı aktif parçalar gerçek MPN’e özgü model yerine genel aile modeliyle simüle ediliyor.
- Robustness sınıflandırmasının örnek sayısı ve istatistiksel eşiği birbiriyle uyumlu değil.

Gerekli hedef:

1. Kullanıcı girdisinden LLM’den bağımsız `RequirementSpec[]` oluşturulmalı.
2. Her assertion; requirement kimliği, ölçü, hedef, birim ve toleransla bağlı olmalı.
3. Schema → ERC → netlist → simulation → assertion sırası zorunlu ve fail-closed olmalı.
4. Kriter yoksa sonuç `simulates/unverified` olmalı; `verified/pass` olmamalı.
5. Generic-model ve part-specific-model kanıt seviyeleri açıkça ayrılmalı.

### 2. PCB’de doğrulanan artifact ile teslim edilen üretim artifact’ı aynı kanıt zincirinde değil

KiCad DRC kontrolü ile müşteriye sunulan Gerber üretimi aynı final board artifact’ından türetilmiyor. Bu nedenle temiz DRC sonucu, indirilen bütün üretim dosyalarının birebir aynı fiziksel tasarımı temsil ettiğini tek başına kanıtlamıyor.

Ayrıca DRC başarısız olduğunda bazı fallback yollarında artifact üretimi ve başarılı job durumu devam edebiliyor. Ground pour ve fiziksel pin eşleme gibi alanlarda da ek parity kontrolleri gerekiyor.

Gerekli hedef:

1. Final, zone-refill uygulanmış `.kicad_pcb` tek kaynak olmalı.
2. KiCad CLI aynı board’dan DRC, Gerber ve drill çıktısı üretmeli.
3. Bundle; manifest, checksum ve DRC attestation içermeli.
4. DRC, parity veya completeness başarısızsa manufacturing export yayımlanmamalı.
5. Logical port → physical pad eşlemesi onaylı footprint pin-map verisine dayanmalı.

### 3. Reproducible production packaging tamamlanmamış

Temiz container build testlerinde API’nin development ve production target’larında ayrı packaging sorunları görüldü. Bunlar uygulama kodundan bağımsız olsa da release’i doğrudan engeller.

Gerekli hedef:

- Windows/Linux satır-sonu davranışı repository seviyesinde sabitlenmeli.
- Prisma client üretimi production image aşamalarıyla uyumlu hale getirilmeli.
- Runtime bağımlılıkları final image içinde doğrulanmalı.
- API ve PCB worker yetkisiz kullanıcıyla çalışmalı.
- Migration, image smoke test ve readiness kontrolleri release pipeline’ın zorunlu adımları olmalı.

### 4. Kullanıcıya sunulabilir ana ürün yüzeyi henüz yok

Repository bugün ağırlıklı olarak backend ve EDA motorudur. Mevcut frontend yalnızca statik örnekleri gösteren bağımsız bir 3D viewer niteliğindedir.

Eksik ana yüzeyler:

- Şematik editör ve wiring deneyimi
- Waveform, probe ve simulation UI
- AI generate/repair/evidence deneyimi
- Gerçek PCB editörü ve manuel düzeltme akışı
- Undo/redo, visual diff ve review
- Realtime collaboration, comments ve presence
- Project-level permissions
- UI unit, Playwright, accessibility ve visual regression kapıları

### 5. Tasarım verisi ve uzun süren job güvenilirliği güçlendirilmeli

- Version, working-copy ve bazı layout girişleri canonical CircuitJson şemasına göre write boundary’de doğrulanmıyor.
- Autosave last-writer-wins çalışıyor; revision veya optimistic concurrency bulunmuyor.
- Queue adları ortamlar arasında namespace taşımıyor.
- Bazı database → queue geçişlerinde outbox/reconciliation güvencesi eksik.
- Multi-org design job’larında hedef organizasyon açıkça seçilmiyor.
- Bir PCB job’ının bağlandığı version ile gönderilen circuit içeriğinin aynı tasarım olduğu doğrulanmıyor.

Gerekli hedef: strict schema validation, revision/ETag, environment queue prefix, idempotent job kimliği, transactional outbox veya reconciliation ve açık org/project scope.

### 6. Platform güvenilirliği ve izolasyon

Bağımsız güvenlik incelemesi, kullanıcı tarafından sağlanan simülasyon girdilerinin işlenmesi, build context yönetimi, servisler arası yetki ayrımı ve production configuration alanlarında ek sertleştirme gerektiğini gösterdi.

Hassas teknik ayrıntılar bu paylaşılabilir belgeden çıkarılmıştır. Production öncesi şu sonuçlar bağımsız olarak doğrulanmalıdır:

- Kullanıcı girdisi işleyen simülasyon katmanı ağ ve servis kimliklerinden ayrılmış olmalı.
- İzolasyon başarısız olduğunda işlem devam etmemeli.
- Build context ve image katmanları hassas yapılandırma materyali içermemeli.
- API, simülasyon worker ve PCB worker ayrı ve en düşük yetkili servis kimlikleri kullanmalı.
- Authentication, session lifecycle ve administrator bootstrap prosedürleri production politikalarına bağlanmalı.
- Object storage private olmalı; tenant ve environment prefix’leri kullanılmalı.
- Güvenlik kontrolleri, bağımsız güvenlik doğrulaması ve threat-model review ile onaylanmalı.

## Kalite ve operasyon açıkları

- `lint` mevcut yapılandırmada TypeScript parser service hatası nedeniyle çalışmıyor.
- `format:check` generated dosyaları da kapsadığı için yüzlerce dosyada kırılıyor.
- Mevcut dependency audit komutu kullanılan eski endpoint nedeniyle sonuç üretemiyor.
- CI’da dependency, container, hassas-veri ve IaC taraması; SBOM, image signing ve provenance zorunlu değil.
- Production IaC, managed HA servisleri, backup/PITR, restore drill, RPO/RTO ve rollout/rollback prosedürleri tamamlanmamış.
- Çoklu replica için shared rate limiting ve güvenli varsayılan kotalar gerekli.
- Worker heartbeat, queue age, API hata oranı, dış servis ve job başarısızlıkları için production alarm seti eksik.
- Load/stress/soak testleri ve tanımlı SLO/error budget bulunmuyor.

## Canlı entegrasyon notları

- TME katalog entegrasyonu genel olarak çalışıyor; live test beklentilerinden biri güncellenmeli.
- Yapılandırılmış LLM sağlayıcı doğrulaması başarılı olmadığı için canlı AI generate → repair → verify başarı yolu bu incelemede tamamlanamadı.
- Bu nedenle AI özelliğinin production doğrulaması, geçerli test hesabıyla kontrollü staging ortamında tekrar yapılmalı.

## Flux.ai karşılaştırması

16 Temmuz 2026 itibarıyla Flux’ın resmi sayfaları şu ürün yüzeylerini tanımlıyor:

- Düzenlenebilir, browser tabanlı eCAD
- Sekiz katmana kadar PCB
- Realtime collaboration, version control ve gelişmiş permissions
- Live inventory, pricing ve alternate parts
- Automated design-rule ve manufacturability kontrolleri
- Gerber, drill, BOM ve pick-and-place export
- Prompt tabanlı built-in circuit simulation
- Enterprise seviyesinde idari kontroller ve veri koruma taahhütleri

Resmi kaynaklar:

- https://www.flux.ai/
- https://www.flux.ai/p/blog/simulate-circuits-with-a-prompt
- https://www.flux.ai/p/enterprise
- https://www.flux.ai/p/blog/real-time-pcb-collaboration

Flux’ın ana sayfası Altium/Cadence schematic ve KiCad part-library importundan bahsediyor; layout importunun henüz desteklenmediğini ayrıca belirtiyor.

Circuit Forge’ın farklılaşma potansiyeli; gerçek ngspice, fizik beklentili regresyonlar, Monte Carlo/corner analizi ve ölçülebilir evidence pack yaklaşımıdır. Bu avantajın güvenilir ürün iddiasına dönüşmesi için requirement binding, ERC gating ve exact-artifact PCB zinciri tamamlanmalıdır.

## Önerilen uygulama sırası

1. Typed requirement contract, ERC hard gate ve boş assertion yasağı.
2. Final KiCad artifact → DRC → Gerber/drill → checksum attestation zinciri.
3. Simülasyon girdisi izolasyonu ve servisler arası least-privilege mimarisi.
4. Reproducible production image, migration ve smoke-test release gate’leri.
5. CircuitJson write-boundary validation, optimistic autosave ve queue reliability.
6. Gerçek schematic → AI → simulation → waveform → version → PCB frontend vertical slice.
7. Backup/restore, SLO, load test, monitoring ve incident runbook.
8. Collaboration, project ACL, SSO/SCIM, multi-layer PCB ve managed component library.

## Sonuç

Circuit Forge’ın EDA ve simülasyon çekirdeği alışılmadık derecede güçlü bir temel sunuyor. Ancak ürün yüzeyi, doğrulama semantiği, manufacturing traceability ve production operasyonları tamamlanmadan genel kullanıma açılmamalıdır.

Önerilen yayın etiketi: **internal alpha/beta — engineering review required**.
