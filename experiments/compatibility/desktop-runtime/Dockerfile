# Single-platform Ubuntu 24.04 digests per lane; BuildKit selects the stage from --platform. Apple Silicon first.
FROM ubuntu@sha256:18b33ff3829707f31ada654a963b9ee35f2e6f0241b964bd17a22a9b330cb63d AS base-arm64
FROM ubuntu@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc AS base-amd64
FROM base-${TARGETARCH}
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN case "$TARGETARCH" in \
      arm64) triplet=aarch64-linux-gnu; pin=a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d ;; \
      amd64) triplet=x86_64-linux-gnu; pin=1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26 ;; \
      *) echo "unsupported controller architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && apt-get update && apt-get install --yes --no-install-recommends \
      python3 sudo procps docker.io gcc-13=13.3.0-6ubuntu2~24.04.1 libc6-dev \
    && ln -s "/usr/bin/$triplet-gcc-13" /usr/local/bin/gcc \
    && echo "$pin  /usr/local/bin/gcc" | sha256sum --check \
    && dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' > /controller-packages.tsv \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/python3", "-I", "-u", "/controller/entry.py"]
COPY controller/ /controller/
