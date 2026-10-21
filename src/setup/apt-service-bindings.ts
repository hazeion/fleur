import type { AptInstallProfile } from "./native.ts";
/** Unit bytes authenticated against these exact official package artifacts; not native proof. */
const bindings = [
  {
    "distribution": "ubuntu",
    "release": "24.04",
    "architecture": "x64",
    "packages": {
      "docker-ce": {
        "version": "5:29.9.1-1~ubuntu.24.04~noble",
        "sha256": "463a666215797c9f9ea7d0ad1751de5b2b3806a1b539a3550e16822ef34ccbfd",
        "size": 24548040
      },
      "containerd.io": {
        "version": "2.4.2-2~ubuntu.24.04~noble",
        "sha256": "7327ab23182425e94b46a91567e9ddf0183f9b3a5ed53d5e2489f000dbf9cfe2",
        "size": 23270672
      }
    }
  },
  {
    "distribution": "ubuntu",
    "release": "24.04",
    "architecture": "arm64",
    "packages": {
      "docker-ce": {
        "version": "5:29.9.1-1~ubuntu.24.04~noble",
        "sha256": "3f9affcfd066100a255dc7c42ab7afd1dafbeec1790c3fa0e82a4ff875334d03",
        "size": 21022288
      },
      "containerd.io": {
        "version": "2.4.2-2~ubuntu.24.04~noble",
        "sha256": "a24f7d5dbe60f7d6e76fccc9c9713609311ab61536a7a01ef858e7eccc698d92",
        "size": 19567180
      }
    }
  },
  {
    "distribution": "ubuntu",
    "release": "26.04",
    "architecture": "x64",
    "packages": {
      "docker-ce": {
        "version": "5:29.9.1-1~ubuntu.26.04~resolute",
        "sha256": "cb283f77ac1a9e010d1dbe656be58063617e1360ca9f48e5ebe61cf72d2ac96b",
        "size": 24584460
      },
      "containerd.io": {
        "version": "2.4.2-2~ubuntu.26.04~resolute",
        "sha256": "6bb52a00ac068d78f0fc090b69bb8e5efe355d2069b9f90d2ebbae23b9d5b36b",
        "size": 23265404
      }
    }
  },
  {
    "distribution": "ubuntu",
    "release": "26.04",
    "architecture": "arm64",
    "packages": {
      "docker-ce": {
        "version": "5:29.9.1-1~ubuntu.26.04~resolute",
        "sha256": "82dcc11c6804fb83c4b74c0aa0dc0cd5d2d1bd0fa7736e65454f3092ea94e01d",
        "size": 21074948
      },
      "containerd.io": {
        "version": "2.4.2-2~ubuntu.26.04~resolute",
        "sha256": "aa0a07eb4faa4d037e0f6ce1402e5440a286a19d56b29b0bafd0f4b52f5ead42",
        "size": 19570456
      }
    }
  },
  {
    "distribution": "debian",
    "release": "13",
    "architecture": "x64",
    "packages": {
      "docker-ce": {
        "version": "5:29.9.1-1~debian.13~trixie",
        "sha256": "b33133205350e2765df0cc382f5a3ee44c2cfd4cdc3dc6ba32eca40839ac3574",
        "size": 24553192
      },
      "containerd.io": {
        "version": "2.4.2-2~debian.13~trixie",
        "sha256": "a3e696cb98baafbb63895dc18b53f143088a2ead95c57820ac90dc5e1d61b05d",
        "size": 23262120
      }
    }
  },
  {
    "distribution": "debian",
    "release": "13",
    "architecture": "arm64",
    "packages": {
      "docker-ce": {
        "version": "5:29.9.1-1~debian.13~trixie",
        "sha256": "0e92412b105738c532b7b918ab2fa6b00fa195c346dcf493c0c048d318556f32",
        "size": 21035860
      },
      "containerd.io": {
        "version": "2.4.2-2~debian.13~trixie",
        "sha256": "ec62600bdae178642eb3a6bc9817ff9ccd95a5891b6c3076ffbba11f3b4d1da6",
        "size": 19563080
      }
    }
  }
] as const;
export function hasAptServiceBinding(profile: AptInstallProfile): boolean {
  return bindings.some((entry) => entry.distribution === profile.distribution && entry.release === profile.release && entry.architecture === profile.architecture && Object.entries(entry.packages).every(([name, expected]) => {
    const actual = profile.artifacts[name as keyof typeof profile.artifacts];
    return actual.version === expected.version && actual.sha256 === expected.sha256 && actual.size === expected.size;
  }));
}
