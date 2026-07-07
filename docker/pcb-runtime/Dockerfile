# pcb-worker RUNTIME image (LAYOUTJOB_PLAN.md M3 core) — the environment where pcb-core runs the PCB
# pipeline with NATIVE tools (no Docker-in-Docker):
#   • base kicad/kicad:10.0-full → kicad-cli + the 3D model library at /usr/share/kicad/3dmodels
#   • Temurin JRE + fontconfig   → freerouting.jar headless (AWT needs fonts)
#   • Node 22                    → tscircuit autorouter needs iterator helpers (the CI-gate lesson)
#   • freerouting-executable.jar → copied from the PINNED freerouting image (no separate download)
#
# Code is NOT baked here — for verification we mount the repo; the final worker (M3) will COPY its
# built bundle. This image only provides the TOOLCHAIN.
#
# DIGEST-PINNED (not just tags): kicad-cli IS the DRC/manufacturability oracle and freerouting IS the
# router — their verdicts must be reproducible. `10.0-full` is a mutable minor tag that KiCad re-pushes
# on every 10.0.x patch; a silent re-tag would change DRC rules/exit-codes and flip verdicts with no
# code change (the repo already got burned by ngspice version drift only-in-CI). Node stays major-pinned
# (node_22.x) — it only spawns the tools via execFileSync and cannot change a DRC/route verdict.
# To bump: re-resolve with `docker inspect --format '{{index .RepoDigests 0}}' <image>` and re-run test:layout.
FROM kicad/kicad:10.0-full@sha256:fd4b9a49145872bbb1397d0eee4e10f50e69fbf25b1506d996216d120ff681e1
USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig ca-certificates curl gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Java runtime AND the jar, BOTH from the pinned freerouting image → guaranteed version-match. The jar is
# compiled for Java 25; installing a different JRE (apt's openjdk-21) throws UnsupportedClassVersionError.
# Temurin's runtime under /opt/java is self-contained and runs on the kicad base's (newer) glibc.
COPY --from=ghcr.io/freerouting/freerouting:2.2.4@sha256:0d010c6bf13b562551e8cb41fb298090006033fa2850e5bfc678c98ecf47111e /opt/java/openjdk /opt/java/openjdk
COPY --from=ghcr.io/freerouting/freerouting:2.2.4@sha256:0d010c6bf13b562551e8cb41fb298090006033fa2850e5bfc678c98ecf47111e /app/freerouting-executable.jar /app/freerouting-executable.jar

ENV JAVA_HOME=/opt/java/openjdk \
    PATH=/opt/java/openjdk/bin:$PATH \
    FREEROUTING_JAR=/app/freerouting-executable.jar \
    KICAD_CLI=kicad-cli \
    JAVA_BIN=/opt/java/openjdk/bin/java

RUN node --version && java -version && kicad-cli version
