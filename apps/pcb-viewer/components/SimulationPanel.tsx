'use client';

/**
 * The Simulate control and — just as important — what it says when there is nothing to animate.
 *
 * A viewer that answers "Simulate" with a board that does not visibly change has told the user something
 * false by omission: they read it as "this circuit does nothing". The reasons a board sits still are
 * different facts and each gets its own words:
 *
 *   • the deck did not contain the part that does the work (a catalog-only IC with no SPICE model),
 *   • the simulation could not run at all, and why,
 *   • the circuit genuinely holds a steady state — a regulated rail is SUPPOSED to be flat.
 */
import type { SimulationCoverage } from '../lib/simulation';

export type SimState =
    | { kind: 'idle' }
    | { kind: 'running' }
    | {
          kind: 'playing';
          nets: number;
          unresolved: string[];
          span: number;
          time: number;
          min: number;
          max: number;
          /** Wall-clock seconds for one pass, so the panel can state the slow-down instead of implying real time. */
          loopSeconds: number;
          /** Carried on the PLAYING state too, not just on failure. A board whose IC has no model still
           *  animates — its passive network is real — and that is precisely when a viewer showing a smooth
           *  waveform and saying nothing is at its most misleading. */
          coverage?: SimulationCoverage;
          /** What the run was expected to show, from the board's own plan. */
          note?: string;
      }
    | { kind: 'unavailable'; reason: string; coverage?: SimulationCoverage };

const fmtV = (v: number): string => (Math.abs(v) >= 1 ? `${v.toFixed(2)} V` : `${(v * 1000).toFixed(0)} mV`);
/** 1200 -> "1200×", 1.2e6 -> "1.2M×" — a slow-down factor a person can read at a glance. */
const fmtRate = (r: number): string =>
    r >= 1e6 ? `${(r / 1e6).toFixed(1)}M×` : r >= 1e3 ? `${(r / 1e3).toFixed(1)}k×` : `${r.toFixed(r < 10 ? 1 : 0)}×`;
const fmtT = (s: number): string =>
    s >= 1 ? `${s.toFixed(3)} s` : s >= 1e-3 ? `${(s * 1e3).toFixed(2)} ms` : `${(s * 1e6).toFixed(1)} µs`;

const btn = (primary: boolean): React.CSSProperties => ({
    background: primary ? '#1b2b22' : '#111a1f',
    color: '#e7efe8',
    border: `1px solid ${primary ? '#e3b45f' : 'rgba(255,255,255,.12)'}`,
    borderRadius: 10,
    padding: '8px 12px',
    font: '600 13px ui-sans-serif, system-ui',
    cursor: 'pointer',
});
const line: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 11 };
const dim: React.CSSProperties = { color: '#8fa79b' };
const warn: React.CSSProperties = { fontSize: 11, color: '#e3b45f', lineHeight: 1.5 };

export function SimulationPanel({
    state,
    onSimulate,
    onStop,
    playing,
    onTogglePlay,
}: Readonly<{
    state: SimState;
    onSimulate: () => void;
    onStop: () => void;
    playing: boolean;
    onTogglePlay: () => void;
}>) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', gap: 6 }}>
                {state.kind === 'playing' ? (
                    <>
                        <button type="button" onClick={onTogglePlay} style={btn(true)}>
                            {playing ? '❚❚ Duraklat' : '▶ Oynat'}
                        </button>
                        <button type="button" onClick={onStop} style={btn(false)}>
                            Durdur
                        </button>
                    </>
                ) : (
                    <button
                        type="button"
                        onClick={onSimulate}
                        disabled={state.kind === 'running'}
                        style={{ ...btn(true), opacity: state.kind === 'running' ? 0.55 : 1 }}
                    >
                        {state.kind === 'running' ? 'Simüle ediliyor…' : '▶ Simüle et'}
                    </button>
                )}
            </div>

            {state.kind === 'playing' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div style={line}>
                        <span style={{ ...dim, width: 40 }}>t</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtT(state.time)}</span>
                        <span style={dim}>/ {fmtT(state.span)}</span>
                    </div>
                    {/* The animation is NOT real time, and the motion must not be left to imply that it is.
                        A 5 ms transient shown over 6 s is a 1200× slow-down and the number is stated. */}
                    <div style={line}>
                        <span style={{ ...dim, width: 40 }}>hız</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {state.span > 0 ? `${fmtRate(state.loopSeconds / state.span)} yavaş` : '—'}
                        </span>
                        <span style={dim}>({state.loopSeconds.toFixed(0)} sn'de bir tur)</span>
                    </div>
                    <div style={line}>
                        <span style={{ ...dim, width: 40 }}>aralık</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmtV(state.min)} … {fmtV(state.max)}
                        </span>
                    </div>
                    {/* The same cold→hot ramp the shader applies, so the board can be read against it. */}
                    <div
                        aria-hidden="true"
                        style={{
                            height: 6,
                            borderRadius: 3,
                            background:
                                'linear-gradient(90deg, rgb(13,64,217) 0%, rgb(38,217,140) 50%, rgb(255,140,26) 100%)',
                        }}
                    />
                    <div style={{ ...line, ...dim, lineHeight: 1.5 }}>
                        {state.nets} net, ölçülen düğüm gerilimleriyle sürülüyor
                    </div>
                    {state.unresolved.length > 0 && (
                        // Named, not counted. A net left uncoloured because we never had its voltage looks
                        // exactly like one sitting at 0 V, and the difference is the user's to know.
                        <div style={warn}>
                            {state.unresolved.join(', ')} için simüle edilmiş gerilim yok — sıfır gibi boyanmak yerine
                            renksiz bırakıldı
                        </div>
                    )}
                    {/* The most important line on this panel. Everything above describes a smooth, confident
                        animation; this says whether it is an animation OF THE BOARD. */}
                    <CoverageNote coverage={state.coverage} />
                    {state.note && <div style={{ ...dim, fontSize: 11, lineHeight: 1.5 }}>{state.note}</div>}
                </div>
            )}

            {state.kind === 'unavailable' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={warn}>{state.reason}</div>
                    <CoverageNote coverage={state.coverage} />
                </div>
            )}
        </div>
    );
}

/**
 * What the deck did NOT contain — rendered wherever a simulation is being reported, which is the whole
 * point. This used to live only on the failure branch, so the three gallery boards that simulate happily
 * WITHOUT their IC (a 7805, a 555, a '595) animated in silence: a smooth waveform, a net count, and not a
 * word about the missing part. That is the exact silence the coverage check was built to end, reintroduced
 * one layer above it.
 */
function CoverageNote({ coverage }: Readonly<{ coverage?: SimulationCoverage }>) {
    if (!coverage || coverage.complete) return null;
    const parts = coverage.loadBearing.map((o) => `${o.designator} (${o.type})`).join(', ');
    return (
        <div style={warn}>
            ⚠ Deck {parts} içermiyor — simüle edilebilir modeli yok. Burada gördüğünüz, kartın geri kalan pasif ağı;{' '}
            {coverage.loadBearing.length === 1 ? 'o parçanın' : 'o parçaların'} bulunduğu yerde devrede bir açık var,
            dolayısıyla bu animasyon kartı çizildiği gibi tarif etmiyor.
        </div>
    );
}
