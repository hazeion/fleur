FROM ubuntu@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install --yes --no-install-recommends \
      python3 sudo procps docker.io gcc-13=13.3.0-6ubuntu2~24.04.1 libc6-dev \
    && ln -s /usr/bin/x86_64-linux-gnu-gcc-13 /usr/local/bin/gcc \
    && echo '1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26  /usr/local/bin/gcc' | sha256sum --check \
    && dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' > /controller-packages.tsv \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/python3", "-I", "-u", "/controller/entry.py"]
COPY controller/ /controller/
