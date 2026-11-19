FROM kraken/tentacle-base
USER root
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libicu-dev libssl-dev python3 jq unzip xz-utils ca-certificates curl sqlite3 time linux-perf \
      libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libdbus-1-3 libx11-6 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 libxkbcommon0 libasound2t64 libatspi2.0-0t64 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
# Node (newest LTS) for the MCP siblings
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
# tree-sitter CLI, pinned to the version tree-sitter-al generates with; global, so on PATH for user dev
RUN HOME=/tmp/build-home npm install -g --cache /tmp/npm-cache tree-sitter-cli@0.27.0 \
    && HOME=/tmp/build-home tree-sitter --version && rm -rf /tmp/npm-cache /tmp/build-home
# Headless Chromium (Chrome Headless Shell) for page checks: Playwright pinned at 1.65.1 (1.56 hangs on Node 26 and refuses
# Ubuntu 26.04), installed into the image so a fresh volume has it; its system libraries are on the first apt line
RUN HOME=/tmp/build-home PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y --cache /tmp/npm-cache playwright@1.65.1 \
      install chromium-headless-shell && rm -rf /tmp/npm-cache /tmp/build-home
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# LLVM/clang 23.1.2: pinned, the native parser's staleness check refuses any other clang
# install-llvm.sh takes only the platform key and installs under ${TMPDIR}/llvm-<version>
COPY scripts/install-llvm.sh /tmp/install-llvm.sh
RUN TMPDIR=/opt bash /tmp/install-llvm.sh linux-x64 && test -x /opt/llvm-23.1.2/bin/clang \
    && rm -f /tmp/install-llvm.sh /opt/llvm-23.1.2.tar.xz
# Rust (stable) outside the cache volume (the base points CARGO_HOME at ~/.cache for the registry)
ENV RUSTUP_HOME=/opt/rustup
RUN curl -fsSL https://sh.rustup.rs | CARGO_HOME=/opt/cargo sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
ENV PATH=/opt/cargo/bin:$PATH
# .NET 10 SDK + 8 runtime (alc/altool run on 10; the 8 runtime served the retired .NET al-runner, R654, and is
# kept until nothing is shown to need it)
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel 10.0 --install-dir /opt/dotnet \
    && bash /tmp/dotnet-install.sh --channel 8.0 --runtime dotnet --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/opt/dotnet PATH=/opt/dotnet:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1
# AL extension: the newest STABLE one on the Marketplace (pre-releases carry the property
# Microsoft.VisualStudio.Code.PreRelease=true and are skipped; flags 49 = all versions + properties,
# validated only), resolved through the gallery API at build time (universal
# VSIX: .NET dlls, Windows launchers, no bin/linux) + Linux wrappers, under ~/.vscode/extensions where
# LethAL's defaultAlToolPaths looks. The folder name carries the version, so a stable symlink
# ms-dynamics-smb.al-current points at it (project.yaml's LETHAL_ALC_DIR uses that); defaultAlToolPaths
# skips folders whose suffix is not a version.
RUN ALV="$(curl -fsS -X POST -H 'Content-Type: application/json' -H 'Accept: application/json;api-version=7.1-preview.1' \
         -d '{"filters":[{"criteria":[{"filterType":7,"value":"ms-dynamics-smb.al"}]}],"flags":49}' \
         https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
         | jq -er '[.results[0].extensions[0].versions[] | select(.targetPlatform == null) | select([.properties[]? | select(.key == "Microsoft.VisualStudio.Code.PreRelease" and .value == "true")] | length == 0)][0].version')" \
    && echo "AL extension $ALV" \
    && ALX=/home/dev/.vscode/extensions/ms-dynamics-smb.al-$ALV \
    && curl -fsSL --compressed -o /tmp/al.vsix "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-dynamics-smb/vsextensions/al/$ALV/vspackage" \
    && mkdir -p $ALX \
    && unzip -q /tmp/al.vsix 'extension/*' -d /tmp/al && rm /tmp/al.vsix \
    && cp -r /tmp/al/extension/. $ALX/ && rm -rf /tmp/al \
    && mkdir -p $ALX/bin/linux \
    && for t in alc altool; do printf '#!/bin/sh\nexec /opt/dotnet/dotnet "%s/bin/%s.dll" "$@"\n' "$ALX" "$t" > $ALX/bin/linux/$t; chmod +x $ALX/bin/linux/$t; done \
    && ln -s ms-dynamics-smb.al-$ALV /home/dev/.vscode/extensions/ms-dynamics-smb.al-current \
    && chown -R dev:dev /home/dev/.vscode
# PowerShell from Microsoft's apt repo (the .deb installs its signing key and list). The base is Ubuntu 26.04
# and Microsoft's 26.04 repo has no powershell package yet (measured 2026-10-03), so this uses the 24.04 repo;
# switch to ${VERSION_ID} once the repo carries it. Pinned: powershell is the only package taken from it.
RUN curl -fsSL -o /tmp/ms.deb "https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb" \
    && dpkg -i /tmp/ms.deb && rm /tmp/ms.deb \
    && printf 'Package: *\nPin: origin packages.microsoft.com\nPin-Priority: -1\n\nPackage: powershell\nPin: origin packages.microsoft.com\nPin-Priority: 500\n' > /etc/apt/preferences.d/microsoft-powershell-only \
    && apt-get update && apt-get install -y --no-install-recommends powershell && rm -rf /var/lib/apt/lists/*
# Login shells (bash -l: kraken's setup, ssh sessions) rebuild PATH from /etc/profile, so ENV alone is not enough
RUN printf '%s\n' 'export PATH=/opt/cargo/bin:/opt/dotnet:$PATH' 'export DOTNET_ROOT=/opt/dotnet' 'export RUSTUP_HOME=/opt/rustup' 'export DOTNET_CLI_TELEMETRY_OPTOUT=1' > /etc/profile.d/lethal-tools.sh \
    && chown -R dev:dev /opt/rustup /opt/cargo
# MCP sibling repos live on the work volume (kraken-setup.sh); .mcp.json names /home/dev/src/<repo>
RUN ln -s /work/src /home/dev/src && chown -h dev:dev /home/dev/src
# pi coding agent (newest). Its state and login (auth.json, settings, sessions) default to ~/.pi/agent,
# which is not on a volume; PI_CODING_AGENT_DIR (read by pi's getAgentDir) moves it under the config
# volume so it survives a container recreation. Login shells (ssh) get it from /etc/profile.d.
RUN HOME=/tmp/build-home npm install -g --cache /tmp/npm-cache @earendil-works/pi-coding-agent \
    && HOME=/tmp/build-home pi --version && rm -rf /tmp/npm-cache /tmp/build-home
ENV PI_CODING_AGENT_DIR=/home/dev/.config/pi
RUN printf '%s\n' 'export PI_CODING_AGENT_DIR=/home/dev/.config/pi' > /etc/profile.d/lethal-pi.sh
# ends as root: the base entrypoint drops to dev
