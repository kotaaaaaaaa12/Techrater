FROM debian:bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential ca-certificates curl git pkg-config python3 python3-pip zip unzip tar \
       autoconf automake autoconf-archive libtool linux-libc-dev \
    && pip3 install --break-system-packages cmake==3.31.10 ninja \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/techrater
COPY . .
RUN test -f vcpkg/scripts/buildsystems/vcpkg.cmake \
    || (echo "The vcpkg submodule is missing. Clone Techrater with --recurse-submodules." >&2; exit 1)
RUN grep -q "6154c816446e115f3b164df79ab8d8088eb76b632ee3fdc82ea17cc7ae8d04652c83e5cc587c2c4b334889904b101ba08a04c5837103af260768e93df17cc263" \
       vcpkg/ports/magic-enum/portfile.cmake \
    && sed -i \
       "s/6154c816446e115f3b164df79ab8d8088eb76b632ee3fdc82ea17cc7ae8d04652c83e5cc587c2c4b334889904b101ba08a04c5837103af260768e93df17cc263/fa3792e9c69c57e437d6325b7659cf25e6cbdda3326ffeaf0411d9838822095b15306f322ad2ebd5ec68b905ef2aed08880d2507e7d8a8559ab3c5be6c8ce99c/" \
       vcpkg/ports/magic-enum/portfile.cmake
RUN python3 cloudflare/runtime/patch-techrater.py
RUN ./vcpkg/bootstrap-vcpkg.sh -disableMetrics
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --target Techrater

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates jq redis-server \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/techrater
COPY --from=builder /src/techrater/build/Techrater ./Techrater
COPY cloudflare/runtime/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /app/empty

EXPOSE 8080
CMD ["/app/entrypoint.sh"]
