/**
 * The flow shader: copper coloured by measured voltage, with measured current moving through it.
 *
 * Every constant here traces to a measurement or a published result, not to taste. The short version of
 * why it looks the way it does:
 *
 * CURRENT IS TOKEN FLUX — discrete quanta passing a point — because flux is countable, physically
 * anchored and conserved by the Kirchhoff solve that already produced the data. Rate carries the value;
 * spacing is spent entirely on legibility and doubles as the zoom LOD.
 *
 * FOUR DECADES ARE SPLIT EXPONENT-FROM-MANTISSA. The exponent is a STATIC per-edge tier carried
 * redundantly by hue, head length and amplitude (triple-coded: Nothelfer/Gleicher/Franconeri measured 88%
 * accuracy triple-coded against 66%/58% single); the mantissa rides the flux rate. So the tier never
 * flickers as an AC waveform sweeps decades, and only one decade ever has to fit in a continuous channel.
 *
 * SIGN IS AN ASYMMETRIC PROFILE, never hue and never motion alone — Laidlaw et al. measured 36% reversed
 * direction reads on symmetric patterns, and the encoding has to survive a paused frame and a screenshot.
 *
 * THE TWO QUANTITIES ARE SEPARATED BY A BUDGET, not by hoping they are perceptually distinct: the base
 * layer is hard-clamped at luma 0.70 and the token cores sit at 0.52…8.42, so voltage can never cross the
 * 0.82 bloom gate and current always does above the first tier.
 *
 * UNMEASURED IS A THIRD STATE IN GEOMETRY, not in brightness — a reserved violet-grey off the voltage axis
 * entirely, cross-hatched, never dimmed. Song & Szafir found downplaying missing data degrades both
 * perceived quality and interpretation accuracy; and on a scale where dim means "small current", a dimmed
 * trace reads as small current.
 */

/** Tier core colours, linear. Rec.709 luma 0.469/0.683/0.814/0.742/0.936 — computed, not eyeballed.
 *  Blackbody-ordered teal→green→amber→white so the tone map's own desaturation does the white-hot work. */
export const TIER_COLOR = [
    [0.1, 0.55, 0.75],
    [0.15, 0.85, 0.6],
    [0.55, 0.95, 0.25],
    [1.0, 0.72, 0.2],
    [1.0, 0.93, 0.8],
] as const;

/** Head peak luma 0.52/1.37/2.61/4.08/8.42 — monotonic, ~2× per step. Tier 1 sits BELOW the 0.82 bloom
 *  gate and deliberately never blooms, giving a categorical break at the µA tier. */
export const TIER_AMP = [1.1, 2.0, 3.2, 5.5, 9.0] as const;

/** Halo luma 0.040…0.655, every one under the foot of the widened 0.82→0.92 gate. The halo is authored
 *  as geometry because bloom cannot produce it: a 2 px source over a ~40 px mip deposits ~1.5%. */
export const TIER_HALO = [0.086, 0.156, 0.249, 0.428, 0.7] as const;

/** Head length in SCREEN pixels, fixed. Spatial extent is the strongest continuous channel (Stevens ≈1.0
 *  against brightness 0.33), so it is the tier carrier that survives colour-vision deficiency — where
 *  teal/green/yellow-green would be confusable. A badge must be zoom-invariant, hence px not mm. */
export const TIER_HEAD_PX = [2.0, 3.0, 4.5, 6.5, 9.0] as const;

export const FLOW_VERT = /* glsl */ `
attribute float aNet;
attribute float aEdge;
attribute float aDist;
attribute float aSide;
attribute float aHalfMm;
attribute float aPeakAbs;
attribute vec2  aNormal;

uniform sampler2D uNetTex;
uniform float     uNetCount;
uniform sampler2D uEdgeTex;
uniform vec2      uEdgeTexSize;
uniform float     uPxPerWorld;    // drawingBufferHeight / (2 tan(fov/2))
uniform float     uWorldPerMm;
uniform float     uMinHalfPx;     // screen floor for the drawn ribbon

varying float vVolt;
varying float vAmps;
varying float vPhase;
varying float vMorph;
varying float vPeak;
varying float vDist;
varying float vSide;
varying float vPxPerMm;
varying float vWidthGain;

vec4 edgeTexel(float e) {
    float x = mod(e, uEdgeTexSize.x);
    float y = floor(e / uEdgeTexSize.x);
    return texture2D(uEdgeTex, (vec2(x, y) + 0.5) / uEdgeTexSize);
}

void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Per-vertex, not per-object: the board is tilted, so a single scale would be wrong at one end.
    vPxPerMm = uPxPerWorld * uWorldPerMm / max(-mv.z, 1e-3);

    vVolt = texture2D(uNetTex, vec2((aNet + 0.5) / uNetCount, 0.5)).r;
    vPeak = aPeakAbs;
    vDist = aDist;
    vSide = aSide;

    vec4 e = aEdge < 0.0 ? vec4(0.0) : edgeTexel(aEdge);
    vAmps  = e.r;
    vPhase = e.g;
    vMorph = e.b;

    // Keep a sub-pixel ribbon one filter radius wide and scale its intensity by the width ratio, so the
    // convolution's ENERGY is preserved (GPU Gems 2 ch.22). A 0.2 mm trace is 1.07 px at maxDistance, so
    // this floor is load-bearing rather than theoretical — below it there is no coverage information at
    // all, given multisampling 0 and a spatial-only SMAA.
    float wantHalfMm = aHalfMm;
    float minHalfMm  = uMinHalfPx / max(vPxPerMm, 1e-4);
    float drawHalfMm = max(wantHalfMm, minHalfMm);
    vWidthGain = wantHalfMm / drawHalfMm;

    vec3 widened = position + vec3(aNormal * (drawHalfMm - aHalfMm) * aSide, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(widened, 1.0);
}
`;

export const FLOW_FRAG = /* glsl */ `
precision highp float;

varying float vVolt;
varying float vAmps;
varying float vPhase;
varying float vMorph;
varying float vPeak;
varying float vDist;
varying float vSide;
varying float vPxPerMm;
varying float vWidthGain;

uniform float uVoltAnchor;   // ± this many volts spans the diverging map
uniform float uOpacity;
uniform vec3  uTierColor[5];
uniform float uTierAmp[5];
uniform float uTierHalo[5];
uniform float uTierHeadPx[5];
uniform float uPeriodBaseMm; // 0.25 mm ladder base

int tierOf(float peak) {
    if (peak >= 1e-1) return 4;
    if (peak >= 1e-2) return 3;
    if (peak >= 1e-3) return 2;
    if (peak >= 1e-4) return 1;
    return 0;
}
float decadeFloor(int t) {
    if (t == 4) return 1e-1;
    if (t == 3) return 1e-2;
    if (t == 2) return 1e-3;
    if (t == 1) return 1e-4;
    return 1e-5;
}

/**
 * The comet, convolved analytically with a box filter of width w.
 *
 * A sharp head with an exponential tail: van Wijk notes a sharp edge is what generates contrast, and that
 * cosine or symmetric-Gaussian profiles are "too soft and too diffuse, especially in animations" — which
 * is exactly what reads as a texture scrolling rather than energy moving. The head:tail ratio over a
 * period is e^(1/0.28) ≈ 35:1, well past the 4:1 minimum professional tools use.
 *
 * Filtering by the ANTIDERIVATIVE rather than by smoothstep matters at distance: past the point where the
 * filter width exceeds the feature, adaptive smoothstep fails and the pattern moirés, while this converges
 * to the profile's mean — the trace fades to its average brightness instead of scintillating.
 */
float cometFiltered(float s, float tau, float w) {
    // s in [0,1) is the distance BEHIND the head. Antiderivative of exp(-s/tau) over the pixel footprint.
    float a = clamp(s - w * 0.5, 0.0, 1.0);
    float b = clamp(s + w * 0.5, 0.0, 1.0);
    float span = max(b - a, 1e-5);
    return (tau / span) * (exp(-a / tau) - exp(-b / tau));
}

void main() {
    // ---------------- base layer: the net's voltage.
    //
    // Diverging blue↔amber anchored at 0 V, the axis that survives all three dichromacies, with the two
    // legs luma-matched within 4%. It replaces a cold→mid→hot ramp whose computed luma ran 0.251→0.680→
    // 0.613 — green BRIGHTER than the top of scale, so mid-scale bands bloomed while the extremes did not.
    float t = clamp(vVolt / max(uVoltAnchor, 1e-6), -1.0, 1.0);
    vec3 neutral = vec3(0.09, 0.10, 0.12);
    vec3 lo = vec3(0.36, 0.60, 0.90);
    vec3 hi = vec3(0.80, 0.56, 0.29);
    vec3 base = mix(neutral, t < 0.0 ? lo : hi, abs(t));

    // Across-the-ribbon shading, so copper reads as a rounded conductor rather than a flat decal.
    float across = 1.0 - vSide * vSide;
    base *= 0.72 + 0.28 * across;

    // HARD luma clamp. This reserves the entire range above the bloom gate for CURRENT: without it a rim
    // on a high-voltage net crosses 0.82 and the copper starts glowing, which reads as current.
    float baseLuma = dot(base, vec3(0.2126, 0.7152, 0.0722));
    if (baseLuma > 0.70) base *= 0.70 / baseLuma;

    vec3 color = base;

    if (vPeak < 0.0) {
        // ---------------- UNMEASURED: a third categorical state, in geometry rather than in brightness.
        //
        // Off the voltage axis entirely and BRIGHTER than its mid-scale, so no voltage can ever produce
        // it, and so it is never mistaken for "a small current". Static: zero tokens, zero glow.
        vec3 unknown = vec3(0.52, 0.46, 0.58);
        float pitchMm = 0.55;
        float u = (vDist / pitchMm) + vSide * 0.5;
        float v = (vDist / pitchMm) - vSide * 0.5;
        // Box-filtered on the same footprint the comet uses, so the hatch FLATTENS at distance instead of
        // moiréing into a false texture.
        float w = max(fwidth(u), 1e-3);
        float h = max(step(0.35, fract(u)) * (1.0 - min(w, 1.0)), step(0.35, fract(v)) * (1.0 - min(w, 1.0)));
        color = mix(unknown, unknown * 0.78, h * 0.22);
        gl_FragColor = vec4(color * uOpacity, uOpacity);
        return;
    }

    // ---------------- measured: tokens.
    int tier = tierOf(vPeak);
    float floorA = decadeFloor(tier);
    float m = abs(vAmps) / floorA;

    // Spacing is chosen for LEGIBILITY on a power-of-two ladder, so a rung change drops tokens IN PLACE
    // rather than sliding them over the copper — a continuously-scaled world period swims on every zoom.
    float targetPx = 34.0;
    float k = floor(log2(max(targetPx / max(uPeriodBaseMm * vPxPerMm, 1e-4), 1e-4)));
    float periodMm = uPeriodBaseMm * exp2(k);

    // Position behind the head, in periods. Phase is the BAKED token count, so the pattern advances with
    // the measured current and cannot drift when a frame is dropped.
    float s = fract(vDist / periodMm - vPhase);

    // One filter width covers the pixel footprint AND the travel since the last frame: spatial
    // anti-aliasing and motion blur from a single term.
    float travel = abs(vAmps) / floorA * 0.4 / 60.0;
    float w = max(fwidth(vDist / periodMm), travel);

    // Tail length shortens toward the bottom of a tier, and collapses as the token morphs to a disc.
    float tau = 0.28 * (0.35 + 0.065 * min(m, 10.0)) * max(vMorph, 0.08);
    // Sign flips which end of the period the head sits on — direction lives in the PROFILE, not in hue.
    float sd = vAmps >= 0.0 ? s : 1.0 - s;
    float comet = cometFiltered(sd, max(tau, 0.02), w);

    // Near zero the glyph becomes a stationary symmetric disc: a directional shape at ill-defined
    // orientation jitters, and a MEASURED zero must still read as measured — it keeps its tier hue and
    // halo, so it is never confused with the unmeasured state above.
    float disc = exp(-pow((s - 0.5) * 6.0, 2.0));
    float token = mix(disc, comet, vMorph);

    // Across-the-ribbon falloff: a core with a wider, dimmer halo authored as geometry.
    float coreProfile = exp(-pow(vSide * 2.6, 2.0));
    float haloProfile = exp(-pow(vSide * 1.1, 2.0));

    vec3 tc = uTierColor[tier];
    float headPx = uTierHeadPx[tier];
    // The head is a fixed number of PIXELS, so the tier badge is zoom-invariant.
    float headMm = headPx / max(vPxPerMm, 1e-4);
    float headBoost = clamp(headMm / max(periodMm, 1e-4), 0.05, 1.0);

    color += tc * uTierAmp[tier] * token * coreProfile * headBoost * vWidthGain;
    color += tc * uTierHalo[tier] * token * haloProfile * vWidthGain;

    gl_FragColor = vec4(color * uOpacity, uOpacity);
}
`;
