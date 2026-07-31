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
    | { kind: 'playing'; nets: number; unresolved: string[]; span: number; time: number; min: number; max: number }
    | { kind: 'unavailable'; reason: string; coverage?: SimulationCoverage };

const fmtV = (v: number): string => (Math.abs(v) >= 1 ? `${v.toFixed(2)} V` : `${(v * 1000).toFixed(0)} mV`);
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
                            {state.unresolved.join(', ')} için simüle edilmiş gerilim yok — sıfır gibi boyanmak
                            yerine renksiz bırakıldı
                        </div>
                    )}
                </div>
            )}

            {state.kind === 'unavailable' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={warn}>{state.reason}</div>
                    {state.coverage && !state.coverage.complete && (
                        <div style={warn}>
                            Deck{' '}
                            {state.coverage.loadBearing.map((o) => `${o.designator} (${o.type})`).join(', ')}{' '}
                            içermiyor — simüle edilebilir modeli yok, dolayısıyla burada gösterilecek hiçbir şey
                            kartı çizildiği gibi tarif etmezdi.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
