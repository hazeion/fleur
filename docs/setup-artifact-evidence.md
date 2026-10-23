# Prerequisite installer artifact evidence

Evidence date: 2026-10-19. This records read-only authentication of upstream installer artifacts for issue [#24](https://github.com/hazeion/fleur/issues/24). It does **not** establish fresh installation, ordinary-user daemon readiness or Fleur runtime support for these versions. No installer, package payload or application was executed in this verification.

## Evidence scope

| Layer | Observed result | Remaining proof |
|---|---|---|
| Docker apt | Six signed repository indexes and all 30 exact payload SHA256/size values verified | Native package-manager execution, dependency closure, fresh setup, ordinary-user smoke and exact runtime compatibility |
| Arch packages | Four payload hashes/signatures and 5/5 master certifications per signer verified | Native pacman trust enforcement, complete consistent distro snapshot and fresh setup |
| Desktop disk images | Both exact hashes, strict image signatures and Gatekeeper notarization passed | Full application signature assessment, fresh installation, real agreement action and native daemon/runtime readiness |

The [native prerequisite workflow](../.github/workflows/native-setup.yml) currently checks existing Docker on native Ubuntu 24.04 amd64/arm64. It must not be described as fresh installation proof. A separate owned fresh-VM lane and native Desktop hosts are still required.

## Docker official apt provenance

Primary OpenPGP fingerprint: `9DC858229FC7DD38854AE2D88D81803C0EBFCD88`. Signing subkey: `D3306A018370199E527AE7997EA0A9C3F273FCD8`. Official [Ubuntu key](https://download.docker.com/linux/ubuntu/gpg) and [Debian key](https://download.docker.com/linux/debian/gpg) yielded the same primary/subkey identity.

Ubuntu armored key SHA256: `1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570`. Debian armored key SHA256: `1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570`.

Artifact-specific OpenPGP parsing and the Python cryptography library independently checked each InRelease RSA PKCS#1 SHA512 signature, the primary-to-signing-subkey SHA256 binding, signed Packages.gz SHA256/size, and every downloaded .deb SHA256/size. This research is not a general OpenPGP implementation and is not a substitute for apt signature, expiry/revocation and trust policy enforcement. Production must retain release-scoped Signed-By and exact package versions; a downloaded self-asserted key cannot authorize key rotation.

### ubuntu noble, amd64

[Signed InRelease](https://download.docker.com/linux/ubuntu/dists/noble/InRelease), [package index](https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages.gz).

Observed InRelease SHA256: `a1cf9d68d56338ea9e7dae55ccb68b27dfdf038dddfd08406e44705f1ad81a5a`. Signed index SHA256: `6b8afd21440acf552322180fb30cbd777c510a9ab08ebcd62e29183660ca1e71`.

| Package | Exact version | Bytes | SHA256 |
|---|---|---:|---|
| [docker-ce](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce_29.9.1-1~ubuntu.24.04~noble_amd64.deb) | `5:29.9.1-1~ubuntu.24.04~noble` | 24548040 | `463a666215797c9f9ea7d0ad1751de5b2b3806a1b539a3550e16822ef34ccbfd` |
| [docker-ce-cli](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce-cli_29.9.1-1~ubuntu.24.04~noble_amd64.deb) | `5:29.9.1-1~ubuntu.24.04~noble` | 17593952 | `961968342af4738eb5fb5fc03f9834106c1e454bd010d574cf1a6feae9905efc` |
| [containerd.io](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/containerd.io_2.4.2-2~ubuntu.24.04~noble_amd64.deb) | `2.4.2-2~ubuntu.24.04~noble` | 23270672 | `7327ab23182425e94b46a91567e9ddf0183f9b3a5ed53d5e2489f000dbf9cfe2` |
| [docker-compose-plugin](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-compose-plugin_5.6.0-1~ubuntu.24.04~noble_amd64.deb) | `5.6.0-1~ubuntu.24.04~noble` | 8079740 | `132266d499d9873aafcbe5b515997b8abd714914fa32a62ccac705c1ede7ca81` |
| [docker-buildx-plugin](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-buildx-plugin_0.38.0-1~ubuntu.24.04~noble_amd64.deb) | `0.38.0-1~ubuntu.24.04~noble` | 17783524 | `7094f8b50bc6b239292d475620424a531f7fa0763e466c52ffc3a4037e72bfc5` |

### ubuntu noble, arm64

[Signed InRelease](https://download.docker.com/linux/ubuntu/dists/noble/InRelease), [package index](https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-arm64/Packages.gz).

Observed InRelease SHA256: `a1cf9d68d56338ea9e7dae55ccb68b27dfdf038dddfd08406e44705f1ad81a5a`. Signed index SHA256: `1495f2ae2723f13c7952b6567013ade7a51fba4950b6f05c577bc7ee3f0e7a54`.

| Package | Exact version | Bytes | SHA256 |
|---|---|---:|---|
| [docker-ce](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/docker-ce_29.9.1-1~ubuntu.24.04~noble_arm64.deb) | `5:29.9.1-1~ubuntu.24.04~noble` | 21022288 | `3f9affcfd066100a255dc7c42ab7afd1dafbeec1790c3fa0e82a4ff875334d03` |
| [docker-ce-cli](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/docker-ce-cli_29.9.1-1~ubuntu.24.04~noble_arm64.deb) | `5:29.9.1-1~ubuntu.24.04~noble` | 15846484 | `e9cfb10f2b52fbf7e744791cdd2fcf6e183accc19d8b781dfab5c9c68f697c60` |
| [containerd.io](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/containerd.io_2.4.2-2~ubuntu.24.04~noble_arm64.deb) | `2.4.2-2~ubuntu.24.04~noble` | 19567180 | `a24f7d5dbe60f7d6e76fccc9c9713609311ab61536a7a01ef858e7eccc698d92` |
| [docker-compose-plugin](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/docker-compose-plugin_5.6.0-1~ubuntu.24.04~noble_arm64.deb) | `5.6.0-1~ubuntu.24.04~noble` | 6884008 | `eda8bb0d68dbba07c38d810eff11b00377f8255db802c49707a2f137d219e9d6` |
| [docker-buildx-plugin](https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/docker-buildx-plugin_0.38.0-1~ubuntu.24.04~noble_arm64.deb) | `0.38.0-1~ubuntu.24.04~noble` | 15250860 | `6329557882fa9cb3e00fdc2edbad1de891779f7805e211c05f15f319bf6b725a` |

### ubuntu resolute, amd64

[Signed InRelease](https://download.docker.com/linux/ubuntu/dists/resolute/InRelease), [package index](https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages.gz).

Observed InRelease SHA256: `c403a95a7c7d9aa80d505b8981d251a8d0cefb1d5137be9534907655ab11b321`. Signed index SHA256: `60c0230e076751e0da1040a7f854a7b4a3099edafeefe9f807496a3032926da5`.

| Package | Exact version | Bytes | SHA256 |
|---|---|---:|---|
| [docker-ce](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/amd64/docker-ce_29.9.1-1~ubuntu.26.04~resolute_amd64.deb) | `5:29.9.1-1~ubuntu.26.04~resolute` | 24584460 | `cb283f77ac1a9e010d1dbe656be58063617e1360ca9f48e5ebe61cf72d2ac96b` |
| [docker-ce-cli](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/amd64/docker-ce-cli_29.9.1-1~ubuntu.26.04~resolute_amd64.deb) | `5:29.9.1-1~ubuntu.26.04~resolute` | 17593804 | `3a72d12eccd38f5e0e7b4752ea1912ff36de7238acf7344badebe1c58ae36c82` |
| [containerd.io](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/amd64/containerd.io_2.4.2-2~ubuntu.26.04~resolute_amd64.deb) | `2.4.2-2~ubuntu.26.04~resolute` | 23265404 | `6bb52a00ac068d78f0fc090b69bb8e5efe355d2069b9f90d2ebbae23b9d5b36b` |
| [docker-compose-plugin](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/amd64/docker-compose-plugin_5.6.0-1~ubuntu.26.04~resolute_amd64.deb) | `5.6.0-1~ubuntu.26.04~resolute` | 8081212 | `a0b9c82230ed64bed886f7ac569641fd6aa4e30598c72318ce3bf94cfbe884e6` |
| [docker-buildx-plugin](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/amd64/docker-buildx-plugin_0.38.0-1~ubuntu.26.04~resolute_amd64.deb) | `0.38.0-1~ubuntu.26.04~resolute` | 17784024 | `c1c3fe824d9425d247e99a61b0bb52e1d591fb4d95c5607563a857e7dd49b6be` |

### ubuntu resolute, arm64

[Signed InRelease](https://download.docker.com/linux/ubuntu/dists/resolute/InRelease), [package index](https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-arm64/Packages.gz).

Observed InRelease SHA256: `c403a95a7c7d9aa80d505b8981d251a8d0cefb1d5137be9534907655ab11b321`. Signed index SHA256: `5a21aa986cf17764ff9d592deb7684e10de8b865ddedbb939b030f8ce2c0194f`.

| Package | Exact version | Bytes | SHA256 |
|---|---|---:|---|
| [docker-ce](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/arm64/docker-ce_29.9.1-1~ubuntu.26.04~resolute_arm64.deb) | `5:29.9.1-1~ubuntu.26.04~resolute` | 21074948 | `82dcc11c6804fb83c4b74c0aa0dc0cd5d2d1bd0fa7736e65454f3092ea94e01d` |
| [docker-ce-cli](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/arm64/docker-ce-cli_29.9.1-1~ubuntu.26.04~resolute_arm64.deb) | `5:29.9.1-1~ubuntu.26.04~resolute` | 15849664 | `446aa9d4cb6afd92ae60d947b53dca5c529f99f17e92d35a47907627489165aa` |
| [containerd.io](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/arm64/containerd.io_2.4.2-2~ubuntu.26.04~resolute_arm64.deb) | `2.4.2-2~ubuntu.26.04~resolute` | 19570456 | `aa0a07eb4faa4d037e0f6ce1402e5440a286a19d56b29b0bafd0f4b52f5ead42` |
| [docker-compose-plugin](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/arm64/docker-compose-plugin_5.6.0-1~ubuntu.26.04~resolute_arm64.deb) | `5.6.0-1~ubuntu.26.04~resolute` | 6885648 | `54b87b4bf13de2bf80c07c9b0247da576003371d3113ee059eeccc6b4b15884d` |
| [docker-buildx-plugin](https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/arm64/docker-buildx-plugin_0.38.0-1~ubuntu.26.04~resolute_arm64.deb) | `0.38.0-1~ubuntu.26.04~resolute` | 15250800 | `c6334469343d0cf1f5e8c99e351fe33259dfaf3f2cd5394fec677d6cea51e6f5` |

### debian trixie, amd64

[Signed InRelease](https://download.docker.com/linux/debian/dists/trixie/InRelease), [package index](https://download.docker.com/linux/debian/dists/trixie/stable/binary-amd64/Packages.gz).

Observed InRelease SHA256: `fe8b7cca4253705c8d458d390a7e495a4581dae5a8fefc04234c53563667ba64`. Signed index SHA256: `bad1d1752e790cd5a1c0cd9f9379ba7d3262e71bf6dec4c6b6d6f1789888b273`.

| Package | Exact version | Bytes | SHA256 |
|---|---|---:|---|
| [docker-ce](https://download.docker.com/linux/debian/dists/trixie/pool/stable/amd64/docker-ce_29.9.1-1~debian.13~trixie_amd64.deb) | `5:29.9.1-1~debian.13~trixie` | 24553192 | `b33133205350e2765df0cc382f5a3ee44c2cfd4cdc3dc6ba32eca40839ac3574` |
| [docker-ce-cli](https://download.docker.com/linux/debian/dists/trixie/pool/stable/amd64/docker-ce-cli_29.9.1-1~debian.13~trixie_amd64.deb) | `5:29.9.1-1~debian.13~trixie` | 17593628 | `c89d977d8073de91e7afcd099c82e16cef5506e4d446d006b240e77f78ba4b7d` |
| [containerd.io](https://download.docker.com/linux/debian/dists/trixie/pool/stable/amd64/containerd.io_2.4.2-2~debian.13~trixie_amd64.deb) | `2.4.2-2~debian.13~trixie` | 23262120 | `a3e696cb98baafbb63895dc18b53f143088a2ead95c57820ac90dc5e1d61b05d` |
| [docker-compose-plugin](https://download.docker.com/linux/debian/dists/trixie/pool/stable/amd64/docker-compose-plugin_5.6.0-1~debian.13~trixie_amd64.deb) | `5.6.0-1~debian.13~trixie` | 8080280 | `500327ad3ca6c52f6d142225c7e6830c46a27ff0348a2b2291f0a143d99872ac` |
| [docker-buildx-plugin](https://download.docker.com/linux/debian/dists/trixie/pool/stable/amd64/docker-buildx-plugin_0.38.0-1~debian.13~trixie_amd64.deb) | `0.38.0-1~debian.13~trixie` | 17784020 | `16397aa4052faf9914cfde37ec335c0b5898c6ad2a363b7e12dd897cb6fc5e9b` |

### debian trixie, arm64

[Signed InRelease](https://download.docker.com/linux/debian/dists/trixie/InRelease), [package index](https://download.docker.com/linux/debian/dists/trixie/stable/binary-arm64/Packages.gz).

Observed InRelease SHA256: `fe8b7cca4253705c8d458d390a7e495a4581dae5a8fefc04234c53563667ba64`. Signed index SHA256: `3f4654bd3ddefb4781c31f0325921ffbbe44bf19b432e9b92893cad7e6ff1738`.

| Package | Exact version | Bytes | SHA256 |
|---|---|---:|---|
| [docker-ce](https://download.docker.com/linux/debian/dists/trixie/pool/stable/arm64/docker-ce_29.9.1-1~debian.13~trixie_arm64.deb) | `5:29.9.1-1~debian.13~trixie` | 21035860 | `0e92412b105738c532b7b918ab2fa6b00fa195c346dcf493c0c048d318556f32` |
| [docker-ce-cli](https://download.docker.com/linux/debian/dists/trixie/pool/stable/arm64/docker-ce-cli_29.9.1-1~debian.13~trixie_arm64.deb) | `5:29.9.1-1~debian.13~trixie` | 15846816 | `20b15fb2db59de70cc2172ba1a3cf01b2ab6a2258af20c286b15be2ceca13ecf` |
| [containerd.io](https://download.docker.com/linux/debian/dists/trixie/pool/stable/arm64/containerd.io_2.4.2-2~debian.13~trixie_arm64.deb) | `2.4.2-2~debian.13~trixie` | 19563080 | `ec62600bdae178642eb3a6bc9817ff9ccd95a5891b6c3076ffbba11f3b4d1da6` |
| [docker-compose-plugin](https://download.docker.com/linux/debian/dists/trixie/pool/stable/arm64/docker-compose-plugin_5.6.0-1~debian.13~trixie_arm64.deb) | `5.6.0-1~debian.13~trixie` | 6883300 | `f7b51c2e48afe340074285b6a10f72601e49c7a669100e6ff8b903c257cfc213` |
| [docker-buildx-plugin](https://download.docker.com/linux/debian/dists/trixie/pool/stable/arm64/docker-buildx-plugin_0.38.0-1~debian.13~trixie_arm64.deb) | `0.38.0-1~debian.13~trixie` | 15251080 | `30c717b6b9551eb8758e8197b2789d8e5d53ac5ba3b448e95af60979be0dca79` |

### Authenticated apt side effects

Maintainer scripts were read from the verified packages without executing them. Docker-ce creates the system Docker group if absent, writes AppArmor local configuration and reloads the profile when applicable, updates init defaults, unmasks/enables Docker service and socket, and starts them on fresh installation or restarts on upgrade. Containerd.io similarly unmasks/enables/starts or restarts its service and ships its configuration file. Examined CLI, Compose and Buildx payloads had no package maintainer scripts. Distro dependencies and hooks can have additional effects.

Therefore package installation requires all covered installation, configuration, access/privilege, service-start and service-enable authority before the transaction. Group creation is not user group membership; no user access change is implied. Repository configuration is a separately scoped mutation. No policy-rc.d workaround, automatic conflicting-package removal, socket chmod, user-group addition or global context conversion is justified by this evidence.

Official methods: [Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Debian](https://docs.docker.com/engine/install/debian/).

## Arch official snapshot artifacts

[Snapshot index](https://archive.archlinux.org/repos/2026/10/12/extra/os/x86_64/extra.db), observed SHA256 `6257fcc963adfd914f299884eae839f3ef139daf7c9c4248257d9c959029e849`. Package signatures, not a claimed authenticated database signature, provide the artifact-signature evidence below.

| Package | Exact version | SHA256 | Signing fingerprint |
|---|---|---|---|
| [docker](https://archive.archlinux.org/packages/d/docker/docker-1:29.9.0-1-x86_64.pkg.tar.zst) | `1:29.9.0-1` | `3cc00845b632f3302fe148b939c2736a094599d42e885aab214a5a532bd87d54` | `2E36D8620221482FC45CB7F2A91764759326B440` |
| [docker-compose](https://archive.archlinux.org/packages/d/docker-compose/docker-compose-5.6.0-1-x86_64.pkg.tar.zst) | `5.6.0-1` | `152ccc5e901b5a9ea2d53e29b8ad7b8ec736c9da75bbd224dc472a407578690d` | `601F20F1D1BBBF4A78CF5B6DF6B1610B3ECDBC9F` |
| [containerd](https://archive.archlinux.org/packages/c/containerd/containerd-2.4.1-1-x86_64.pkg.tar.zst) | `2.4.1-1` | `c352b4c019c3d527daa50517a6420a7672b01876b95b80d72dd7192f05220999` | `262A58EC6C51F7EA395B2E2DFDC3040B92ACA748` |
| [runc](https://archive.archlinux.org/packages/r/runc/runc-1.5.2-1-x86_64.pkg.tar.zst) | `1.5.2-1` | `b204e74bba04c491d0bd71f8b5adefff538bbfc516d199bdb1a1513959977dd3` | `05C7775A9E8B977407FE08E69D4C5AA15426DA0A` |

Public keys came from the official [archlinux-keyring 20260909-1 package](https://archive.archlinux.org/packages/a/archlinux-keyring/archlinux-keyring-20260909-1-any.pkg.tar.zst), observed SHA256 `6a8ea16f51d3b305c18322d5884ca959f12c32a3f186873090fdc18465605293`. Package RSA/Ed25519 signatures were verified independently. Each of the four signer identities also had cryptographically checked UID certifications from all five current master fingerprints, and none appeared in the supplied revoked list. These master fingerprints match the official [master-key publication](https://archlinux.org/master-keys/):

- `2AC0A42EFB0B5CBC7A0402ED4DC95B6D7BE9892E`
- `3572FA2A1B067F22C58AF155F8B821B42A6FDCD7`
- `69E6471E3AE065297529832E6BA0F5A2037F4F41`
- `99B6618472A3B3B814185BAED7D3D823B88BDB9B`
- `D8AFDDA07A5B6EDFA7D8CCDAD6D055F927843F1C`

This verifies the inspected signing relationships, not native pacman policy execution or a complete keyring revocation/expiry engine. Production must retain normal trusted distribution keyrings and mandatory signatures. Never autoimport untrusted keys, weaken SigLevel, replace a user mirrorlist, or run a partial/full system upgrade silently.

The four inspected packages have no .INSTALL script. Docker ships systemd units/socket plus sysusers configuration creating the Docker group through distro hooks; starting/enabling services remains separately authorized. Full dependency consistency and other transaction hooks still require native validation against an exact whole-distro snapshot.

## Docker Desktop 4.96.0, build 243774

| Architecture | Official payload | SHA256 | Disk-image verification |
|---|---|---|---|
| amd64 | [Docker.dmg](https://desktop.docker.com/mac/main/amd64/243774/Docker.dmg) | `cdb0a193ba3fc4e1ecaa827061ab1f636df04db60c9bc109a33e2c3a62dad67a` | strict codesign passed; Gatekeeper accepted Notarized Developer ID |
| arm64 | [Docker.dmg](https://desktop.docker.com/mac/main/arm64/243774/Docker.dmg) | `d21bd8787e8761b22c2b1b78c34ffa99abb6c06219b43ba84b6b45087a35c9fe` | strict codesign passed; Gatekeeper accepted Notarized Developer ID |

Hashes match the official [Intel checksums](https://desktop.docker.com/mac/main/amd64/243774/checksums.txt) and [ARM checksums](https://desktop.docker.com/mac/main/arm64/243774/checksums.txt). Both complete disk-image payloads were downloaded and hashed. Apple codesign strict validation passed, and Gatekeeper open assessment accepted each image as Notarized Developer ID.

Intel application metadata identified `com.docker.docker`, x86_64, version 4.96.0, minimum macOS 14.0, TeamID `9BNSXJN65R`. Public leaf certificate subject was Developer ID Application:Docker Inc(9BNSXJN65R), issued by Apple Developer ID Certification Authority, valid 2025-04-22 through 2027-02-01; certificate SHA256 `C8EC0EF4752EEB90790E76CBD55591F2F6F1C50333C08199A17ADCF77DC5CC9D`. These were read-only observations on macOS 15.7.7 Intel, not ARM execution or platform support proof.

Separate deep application validation, explicit app certificate-anchor assessment and Gatekeeper execution assessment did not complete within the bounded inspection period. Their unfinished results are not passes. ARM application-level assessment remains pending. The owned Intel read-only image was detached normally and final image absence verified; no force or system-service intervention was used.

The [official installation method](https://docs.docker.com/desktop/setup/install/mac-install/) involves application placement and configuration. Actual legal acceptance remains a human action; no --accept-license flag or automated acceptance was performed. Default CLI PATH configuration and privileged helpers must be covered separately where exercised. No app launch or Desktop installation/readiness proof occurred.

## Compiler prerequisite milestone, 2026-10-20

A separate owned Ubuntu 24.04 amd64 diagnostic fixture compiled both restriction helpers using the tracked [compiler prerequisite preparation](../scripts/prepare-guest-compiler.py). The source was `91ca8da5584200f8266d2dc0fff21f07a59892f2`; integration merge `e0fceab421876837c404ea0eb6e768a7e5fe2d8f` has the same source tree. The independently checked report SHA256 is `3d029c70f29cddfd8c05d4d3fc07915a9459788f291dd589c55972624d5ce44e`. This adds compiler execution evidence to the earlier artifact authentication; it does not change the historical results above.

The earlier compiler failure came from missing generic `as` and `ld` names because the authenticated package installation supplied only qualified binutils names. The fix creates only guarded aliases to those real binaries, refuses existing names, validates target identity/hash/ELF and compiler search results, and checks custody around compilation. It preserves foreign entries and reports uncertain rollback rather than claiming cleanup. The [source-owned manifest](../scripts/guest-compiler-ubuntu24-amd64.json), all 38 package tuples (59,127,120 bytes), GCC 13.3.0 pin, helper sources, compile flags and deadlines remain unchanged. Manifest SHA256: `11127a1f28b3bac544f79d0f0bc4f91a68afec74568c342bc4bb7c773dcf00d7`; compiler SHA256: `1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26`.

| Helper | Native output | SHA256 |
|---|---|---|
| `filter.so` | ELF machine 62, 30,648 bytes | `99e38df6acbde709100bfcf80c02eee49d364abd8b89838c006e572344da7ab4` |
| `abuse` | ELF machine 62, 16,928 bytes | `67e15a766caaae73f1068cec21150160c8d9d80fcdf527e461d3ed35fae4a1c8` |

Preparation built but did not execute these outputs. The later unchanged restriction probe independently verified the compiler pin and produced matching helper hashes through its ordinary compilation path. Successful aliases were retained for that probe; their `cleanupConfirmed: null` records that rollback was not performed on success. The owned package/build stage was removed. Restriction cleanup, owned sentinel cleanup, final VM reaping and credential removal were confirmed, and two doctor rounds were recorded.

The overall run still failed with `containerd proof host ineligible`: `bounded_probe_passed` and `v1_gate_passed` were false. Initial worker GC observed six collections, 128 retained objects and 16,384 retained bytes; CPU throttling, memory OOM and PID-limit observations were also reached. These are subsets, not complete GC/idle/trace/deadline or runtime-profile proof. The fixture remains diagnostic only, runtime support unverified and installation evidence pending; gate proof and native CPU performance proof remain false. It supplies no human-consent proof, hosted-CI pass or completed issue #24 acceptance criterion. The earlier emulated timing failures remain unresolved by this compiler milestone.

## Owned-guest bounded restriction milestone, 2026-10-21

An owned Ubuntu 24.04 amd64 full-system VM completed the bounded restriction probe at source `a9606d74fd55b252c0aab8432ff72ec513457a5e`. Report SHA256: `75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2`. This is a later successful owned-fixture observation; the failed compiler, emulated timing and host-eligibility history above remains unchanged. Independent review verified the exact source hashes and the scoped native and cleanup evidence.

The original ordinary-account workflow reached a fresh login, two smoke/doctor rounds and `guest.ok: true`, with `installationEvidence: verified-full-system-guest`. The root-owned NoCloud fixture and original account/boot binding enabled only explicit internal host control. Observed server identity was Docker Engine `29.9.1`/`b26fb77`, containerd `2.4.2`/`b7a25261e029d68978bbf290df0a62fc819b3c51`, and runc `1.5.2`/`v1.5.2-0-g29dd3dc2`; ctr revision agreed and worker authority remained unchanged. The GitHub-hosted eligibility path and separate kernel/VFS profiles were not used to authorize this fixture.

The probe reported `bounded_probe_passed: true` and `cleanup_complete: true`:

- Normal and idle lifecycle groups each passed two repetitions under the original 30-second deadline. Healthy work completed while the restricted busy worker remained active. Both idle repetitions retained the registered broker request through the original 11-second acknowledgment pause (observed 11,001 and 11,000 ms).
- Runtime GC observed six collections, 128 retained objects and 16,384 retained bytes; retained heap was verified before each CPU loop. CPU throttling, a memory OOM kill and the 64-PID limit were observed.
- Descriptor/restriction checks, syscall negatives and the event probe completed. All twelve event negatives returned `-1`; the replacement-event negative was rejected as `class-mismatch` before application evaluation, event-probe execution or startup acknowledgment.
- All four physical terminations were confirmed through Linux pidfds, with guards reaped. Physical-exit lateness was 35, 77, 34 and 13 ms. Worker/image/resource cleanup, original Docker inventory and sentinel cleanup, compiler package-stage removal, final VM reaping and credential removal were confirmed.

The unchanged 38-package compiler closure and exact GCC pin compiled the original helper sources and flags. The preparer built without executing the outputs; the restriction probe subsequently used its ordinary build/execution path and recorded the same `filter.so` and `abuse` SHA256 values as the compiler milestone above. The following hashes bind the new observation to its verifier, archived probe and relevant sources:

| Evidence | SHA256 |
|---|---|
| Full verifier source | `e621cedee5c454f8646fc30a561ac70a4667b4fd0d21473cddfbfe9e2915d2d3` |
| Private HVF diagnostic script | `3f7c851f4c919d285bd6d6004f673805ab1cda0a10bdd767e4351c7d3e85d4c0` |
| Tracked restriction archive | `0b2776a10ebbee0608a52d47acb530458390285bc91656b8cfcb213ad780e636` |
| Compiler preparation source | `72ac71d3d06aafc263e5adf0ef5250036a44166867af84875144e403b0e887bd` |
| `filter.c` | `533a20d7d4e151f023146a216cc802231669c08113533fde09253892030043dc` |
| `abuse.c` | `610850ac43bff233b887e27626cee91f93fd2c74c98befe1f03ae92a7d7b179a` |
| `owned_guest.py` | `989cd77bc9f513b6a4c3dfef8ae674e4fec16c3b061442207a0db7ce610153a0` |
| `host_control.py` | `126a0a9f13a1c514a9d2db87b0f1bbbbb8c60879125edcfac8d58cdf9af9392d` |
| `privileged_control.py` | `2bc3610d3ee103b7318284bc1a4251ad198b15105177d05147ca0574558b875f` |

The private Darwin x64 HVF diagnostic used explicit host CPU selection without fallback; it supplies no native CPU performance proof. Its outer result intentionally remained exit `4`, `ok: false`, `DIAGNOSTIC_ONLY`, `gateProof: false` and `v1_gate_passed: false`, even after guest success. Runtime support remains unverified and the ordinary catalog stays disabled. Human-consent proof is false. The hosted matrix is still blocked; this run does not establish hosted CI, another OS/architecture tuple, release admission or completed issue #24 acceptance.

## Intel Desktop existing-installation observation, 2026-10-21

On native Intel macOS 15.7.7 with Bun 1.4.3, the packed ordinary CLI observed an existing Docker Desktop 4.96.1 (244132), Docker CLI 29.9.2/a82e528, Linux Engine 29.9.2/0367cbe and Compose 5.6.0. Source commit: `aa43191a559b1514477b93f7928920a5aed65d5c`. Report SHA256: `904097eb3d1b3bbf3a655375c4cb139a4844145e70efc0fc30e3819312269b56`; verifier SHA256: `635c919556868182406fdf26b053441d95df7aad73d5e6446fef6b9d2ca9cbcb`.

The operator completed Desktop startup. A separately authorized one-time Fleur setup action acquired the exact x64 smoke digest. The existing-only verifier performed no acquisition, installation, startup or configuration change. Both packed doctor rounds reported CLI, daemon, Compose and owned smoke ready with cleanup confirmed. The stopped sentinel remained unchanged, and final cleanup restored the original container inventory and context. An independent reviewer checked the source/report pins and scoped result.

Both doctor results honestly retained exit 4 and release state unverified. This proves repeated existing-tool readiness and preservation for the observed tuple, not assisted DMG installation, human legal acceptance, Desktop application-runtime isolation, Apple Silicon or other release admission. The compiled readiness policy must not infer support from this observation alone.

Repeating the existing-only verifier against ordinary-catalog candidate `37513637b2c6b7e264edfcc36cd02181fc859c1d` produced report `1b5e9ee287d063a0e4d5f48fa325d87280755f0a90ac863eb4b49ad66586d21e`. Both packed rounds again completed smoke cleanup and retained unverified release state. The verifier acquired no image, preserved the stopped sentinel and restored the original container inventory and context. Its wrapper completed in 13.78 seconds without timeout. This confirms that the Ubuntu candidate does not qualify the observed Desktop tuple.

## Release gate

Authenticated artifacts may support a reviewed source-owned candidate installation plan. They must not silently promote an OS/architecture tuple to supported. Record artifact authenticity, installer execution and runtime support as distinct states. Exact source-owned plans must include authenticated dependency closure and all bundled side-effect authority; normal commands cannot accept public profile/verification overrides. Native evidence must include actual packed CLI setup, ordinary-user local daemon and Compose readiness, repeated owned smoke and cleanup, existing-tool preservation, interruption/reprobe behavior, and Fleur restriction compatibility for the exact tuple. Missing evidence remains explicitly open.


## Owned guest boot custody stage

The internal fresh-guest verifier seeds a source-owned Python producer and a
canonical random nonce through NoCloud. Cloud-init runs the producer as root to
create one exclusive read-only manifest binding that nonce, the current kernel
boot ID and the Fleur account UID. Producer failure makes cloud-init incomplete
or degraded; it does not establish readiness.

After completed boot, the host explicitly invokes the read-only custody command
through its pre-pinned SSH transport. The command requires the nonce argument,
Ubuntu24 amd64, a systemd PID1, QEMU/KVM virtualization, an ordinary caller UID,
and protected non-symlink root-owned marker/manifest files and ancestors. It
rechecks retained identities and manifest bytes. Hosted and owned selections
cannot be combined. Environment variables and marker discovery do not activate
owned runtime eligibility.

This stage records fixture custody only. It grants no runtime profile admission,
leaves runtime support unverified, and supplies neither real human consent nor
native CPU performance evidence. The account has sudo; this is not a trust proof
against a privileged adversary. Runtime observer/control integration and binding
the later enrollment/resume chain to this context require separate review. The
existing restriction, lifecycle and cleanup gates remain mandatory.


## Ubuntu ordinary-catalog source mapping

The exact Ubuntu 24.04 x64 prerequisite and official APT records now map the reviewed report `75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2` to source commit `a9606d74fd55b252c0aab8432ff72ec513457a5e` and artifact catalog `540de9d76fc2aa8c260d1579a68c64ff0f1474b61cd332cfd428785432a56e58`. The older diagnostic catalog and its historical pending labels are preserved. This source row covers one prerequisite tuple; it does not promote the global runtime gate or other platforms.

The ordinary Doctor contract additionally binds current daemon resource flags, cgroup driver, rootful/rootless mode and exact security options. The complete Ubuntu systemd/rootful/AppArmor tuple was absent from the older report and has now been captured and checked by the ordinary packed VM run below. Focused synthetic OS fixtures verify selection and rejection behavior, not native execution. Fresh ordinary setup, ready reprobes, exact metadata and cleanup passed in that run. Existing enrollment resume is not evidence of termination during a privileged package transaction; interruption and recovery contracts require their separate tests.


### AppArmor wire-format regression

The first ordinary-catalog VM run at `49978478855cf900e0347d93ec710bb8276ea420` produced report `cf3309135256313884258b17c9477cf268d599a76492c93c94821e32b80e8481`. Official installation, separate enrollment, fresh-session resume and smoke image acquisition completed, but the security-option observer refused an unknown descriptor before the repeated readiness and restriction proof. VM reaping and credential removal were confirmed. The report retained the proposed Engine/kernel/component tuple, systemd cgroup v2 and available resource flags. It redacted the unknown descriptor, so that run does not prove its exact contents or complete ordinary qualification.

The [serializer at the exact Engine build](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/daemon/info.go#L198) emits `name=apparmor,profile=default` for its standard AppArmor template. The proposed record originally used the older bare descriptor. The matcher and observer now recognize only this additional exact standard literal; custom and unconfined profiles remain unavailable, and legacy/default forms cannot count as distinct mechanisms. The row binds the modern literal. The second actual VM run below captured it and passed the unchanged ordinary qualification and restriction checks. Upstream format evidence alone did not establish what the first redacted runtime value was.


## Qualified ordinary Ubuntu prerequisite tuple

Source `28a223cf625a01841fd850accb87de4f8553bb92` completed the ordinary packed proof on a fresh Ubuntu 24.04 x64 guest using Intel HVF with explicit host CPU selection. Report SHA256: `62d29dba9c06b896d5b56503638cc1f261d2282ae9f6e4b931ce3dca238c96ae`. An independent reviewer checked actual report contents, artifact/source hashes and acceptance results.

| Field | Observed exact value |
|---|---|
| Native guest / Bun | Ubuntu 24.04 x64 / 1.4.3 |
| CLI / Engine | 29.9.1/dfc520d / 29.9.1/b26fb77 |
| Kernel / platform | 6.8.0-147-generic / Docker Engine - Community |
| containerd / runc | v2.4.2/b7a25261e029d68978bbf290df0a62fc819b3c51 / 1.5.2/v1.5.2-0-g29dd3dc2 |
| Compose | 5.6.0 |
| Enforcement metadata | systemd, cgroup v2, rootful; CPU period/quota, memory, swap and PID capabilities true |
| Security options | `name=apparmor,profile=default`, `name=seccomp,profile=builtin`, `name=cgroupns` |

Both packed ordinary Doctor rounds returned exit 0 with profile `ubuntu-24.04-x64-docker-29.9.1` and confirmed smoke cleanup. Two ready setup reprobes also returned exit 0 while preserving package/service/source snapshots and grants. The stopped sentinel and original Docker inventory/context were preserved; sentinel cleanup completed. Actual installation used the five authenticated official APT packages, separate action scopes, separate account enrollment, stale-login refusal and a fresh-session resume. The original candidate catalog and its historical labels remain unchanged. The source row retains the earlier installation/restriction report as its evidence reference; this later report additionally proves the ordinary success path and complete enforcement tuple.

The unchanged restriction probe exited 0 with `bounded_probe_passed` and `cleanup_complete` true. It recorded six GC collections with 128 retained objects, 16,384 retained bytes and checksum 8,128. All 24 syscall negatives and twelve event negatives returned `-1`; descriptor/thread restrictions, CPU throttling, memory OOM and the 64-PID bound passed. Normal and idle lifecycle groups each passed two repetitions under the original 30-second deadline. Both idle groups retained the registered request across the required 11-second pause, observed at 11,000 and 11,001 ms. Healthy work completed while the busy worker remained active. All four Linux pidfd physical exits were confirmed, at 32, 33, 66 and 32 ms after their deadlines, with guards reaped. Event replacement was rejected as `class-mismatch` before application evaluation, event execution or startup acknowledgment.

| Provenance | SHA256 |
|---|---|
| Ordinary packed archive | `4d57352791b4ea4e77f23f7b44d4402c666c0f99df60f2dbe7f571931c200d90` |
| Packaged admission metadata | `e046c4e79d54e7bf95fa76e10f31387874b02309f480de4ed824e54df45728a3` |
| Tracked verifier | `b92e6b4f543ffbacfafe7e598cbf5adb993f7d2c9211ba7d9bcb8f09c945b2ba` |
| Private HVF diagnostic | `3760d41665ab2c962bbf7c9dfea6c1b5fc460f20fea8d3517f4b38c2a00d6a66` |
| Audited launcher | `10b930c371ccd41e1325477e086605808f80bc46e4c5b6f7270076ce80335922` |

Worker/image/resource cleanup, compiler-stage removal, final VM reaping and credential removal were confirmed. The private wrapper deliberately ended with `DIAGNOSTIC_ONLY`, exit 4, after successful guest proof. Its global v1 gate, CPU-performance proof and human-consent proof remain false. Those labels do not negate this individually reviewed prerequisite tuple, and they do not qualify other OS/architecture rows, the future full application or assisted Desktop installation. Other promised native platforms and blocked hosted CI remain open. Existing contract tests cover partial-package failure, pending-fence recovery, repository resume and serialization; successful fresh-login resume is not a claim that this VM run terminated during a privileged package transaction.


## Intel Desktop 4.96.1 disk-image authentication

On native Intel macOS 15.7.7, the official Docker Desktop 4.96.1 build 244132 image passed exact byte and SHA256 verification, strict Apple/Docker signature assessment and Gatekeeper open assessment as Notarized Developer ID. The image is 659,125,733 bytes with SHA256 `3d35634cf3dd0373d37d986de10eb744950d3822124615e774335f7be2a1d27a`. The fixed signature requirement includes Docker Team ID `9BNSXJN65R`. Both assessment processes were reaped and their owned process groups were confirmed absent. The original 60-second acceptance allowance and 55-second work fence were preserved.

The first attempt completed in 26.80 seconds with exit 0 and report SHA256 `bb8241fe2d942bebcd26254237146b7947be2c58a58f4ab4bdddc5e274802741`. Independent review checked the exact receipt, operations and retirement facts; root additionally performed full descriptor-held payload readback and checked retained file identity. A second byte-identical attempt completed in 29.69 seconds with exit 0 and report SHA256 `62012b54c67a712052c8938a0b04d9a2bb4422152be5c58ecb20219467010062`. Its strict receipt and full descriptor-held payload readback also passed, with a separate independent evidence review.

This proves the retained DMG input only. No application was mounted, copied, launched or admitted to the source catalog, and no legal agreement or runtime qualification is claimed. The earlier 4.96.0 artifact evidence remains separate. The existing 4.96.1 installed-application trust observations do not establish that installation used this DMG.


## Recorded-helper verification on the existing Ubuntu tuple

Source `9b3018bae74e429ef58633c80eae652fda17dbd0` completed two recorded-helper attempts on the previously reviewed Ubuntu 24.04 x64 tuple using the same reviewed verifier and fixed inputs. It used the ordinary packed CLI, Bun 1.4.3 and the existing digest-pinned image. The fixed helper pair came from the recorded GCC 13.3.0 producer; no consumer-local compiler execution was claimed. The exact source-owned origin record, current C inputs and helper hashes were checked before building.

| Evidence | SHA256 |
|---|---|
| First recorded-helper report | `73320be67ba34cf945cf9a58ea7e388fe960ca48a821fad927ddd7a34cf2c5ca` |
| Repeated recorded-helper report | `cc3698ff55c86684a6133bf6a8de964087cc48d567b431988e4a16ebc67f68c6` |
| Immutable helper-origin manifest | `26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b` |
| Original compiler/export report | `de686cf6344410c3d29e1dcab19bcdabaddc05e4a7d4bdf50320f9c649282bbf` |
| Exact tracked restriction archive | `34d96fb44088422e8ce5ac56cbf66c9068f1723ff723467bd35ad74299e26c07` |

Each attempt used a fresh owned boot. Its initial and resumed sessions preserved the original custody binding and the exact helper-input identities. Two ordinary Doctor rounds and two ready setup reprobes returned exit 0 with the existing qualified Ubuntu profile, owned smoke cleanup, and unchanged snapshots and grants. Independent review verified both attempts' origin, resume/custody chains, source/archive provenance and actual final VM/filesystem disposal. The guest context remained explicitly pending local disposal until the host reaped the VM and confirmed removal of its scratch and overlay.

Both reports record restriction-probe exit 0 with bounded-probe and cleanup predicates true. Independent runtime review accepted both attempts: six GC collections retaining 128 objects and 16,384 bytes with checksum 8,128; all 24 syscall and 12 event negatives; descriptor/thread and real resource enforcement; two normal and two idle 30-second lifecycles per attempt. Idle requests retained their 11-second pauses, and all eight physical pidfd exit measurements stayed within the original 250 ms lateness limit, spanning 27–74 ms. Worker, waiter and guard cleanup remained required. The outer diagnostic deliberately returned exit 4 with `DIAGNOSTIC_ONLY`; its global gate, CPU-performance proof and human-consent proof remain false. This introduces no new platform or release admission.

The earlier attempt at `ce8b997fde5758fecde38c3d5f1b50278641d7e0` remains failed: report `ee7fd0c1da9c47cc84f4ba37f10dd86b2bdad43f3332719897470b09dcd17678` refused context metadata before Docker build. A separate custody-variable overwrite also invalidated its inventory comparison. The repair gives newly created recorded-context inputs fixed readable, non-group-writable permissions and preserves the original inventory variable; it does not weaken the filename, custody or runtime assertions. The earlier receipt did not identify an offending permission value, so its precise inherited-umask cause is not claimed as observed.

At the final source, the full CLI suite passed 815 tests with zero failures; types and full lint also passed. The preceding full run remains recorded as 807 passes, eight failures and one between-test error. No assertions or deadlines changed. All 101 tests in the affected files passed in serial verification, and one finite four-case diagnostic confirmed local retirement while preserving the original deadline and survivor refusals. It found no transport defect in that collection and did not establish the historical failure's cause. Hosted CI and the remaining promised native-platform evidence remain open; this addition does not close issue #24.


## Intel Desktop 4.96.1 private application placement

Two native Intel macOS 15.7.7 attempts exercised source `e36532656e2630ea3e962fa0a2f45e01c0cfb207` through the public `setup --timeout 600` input, using separate owned application destinations. Both performed the original 14 native operations: fresh official download, exact DMG authentication, Apple/Docker signature and Gatekeeper assessments, read-only attachment, mounted/staged application checks, real copy, exclusive publication and normal owned image detach. Every native command retired, and the installed application was preserved. This evidence does not change the default 60-second setup input or the runtime deadlines.

| Attempt | Duration | Receipt SHA256 |
|---|---|---|
| First private placement | 185.80 seconds | `c795b6d5c355afd705b3cdd76e42f1f5cc0b6225fa84a3968f1ddae51645791b` |
| Repeated private placement | 293.13 seconds | `4b48f9de3b1df475d0231a6e4329fb984ef53e49c7794eac9e6d33fa8c7e5447` |

Both source outcomes returned `HUMAN_ACTION_REQUIRED`, exit 3, after completed private placement with cleanup confirmed. Separate once-only image-acquisition and installation fixture grants matched their scoped plans, were consumed, and remained visible as revoked through public grant inspection. Fixture answers are not human-consent evidence. The published bundle identified Docker Desktop 4.96.1 build 244132, Docker Team ID `9BNSXJN65R` and native x86_64. Mounted, staged, published and installed core metadata and hashes agreed. The five-second cleanup reserve, command-specific budgets and normal-detach policy were unchanged.

The first attempt's JSON telemetry rounded epoch nanoseconds through JavaScript numbers. Its native held-descriptor checks were exact before serialization; its accepted readback used exact safely represented identity fields, documented timestamp representation equivalence and fresh full core hashes. Historical raw nanoseconds cannot be recovered from that receipt. The repeated verifier changed only snapshot identity serialization to eight canonical decimal strings and an explicit encoding marker. Its strict consumer required all eight fields to match native identities exactly, with full held-descriptor core hashes and stable named-file checks. Independent review reran that read-only consumer successfully. No floating-point fallback or whole-application atomic-freeze claim was used for the repeat.

The earlier explicit 180-second attempt remains failed: receipt `86250f963d27e9babcb5bbebfcb49a42c1f54ed4bb7ee7f704d00b3c36365c4c`. Its separate normal cleanup did not promote it to success. The 600-second attempts are distinct public-input cases. No global application placement, launch, privileged-helper configuration, legal acceptance, Desktop runtime/release qualification or ARM verification follows from these private placements. Those remaining issue #24 requirements stay open.


## Ubuntu 26.04 x64 installation and runtime evidence

Source `ad3869c6d34e01bebd16a248adeb8c3e53d53d8a` completed two fresh owned
Ubuntu 26.04.1 x64 VM attempts using native Intel HVF execution, Bun 1.4.3, the
frozen Resolute internal candidate and the authenticated recorded helper pair.
The original tracked guest, builder and full restriction probe ran unchanged.
The attempts took 260.72 and 291.63 seconds. Report SHA256 values:

- `f25ad02baf4e5e3d3678da93ce526eead4809504955ba1d9f2cc7cd182da29ac`
- `5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07`

Each completed exact five-package installation, separately authorized Docker
membership enrollment, stale-login refusal, genuine fresh-login recovery, two
ordinary-user smoke rounds, unrelated-state preservation and the complete
restriction/resource/GC/idle/deadline probe. All eight physical exits met the
unchanged 250 ms bound: 61, 62, 31, 66 ms in the first attempt and 39, 32, 78,
64 ms in the second. Both disposed of the owned VM, credentials, scratch and
overlay; independent review confirmed the exact scratch names were absent.

The second attempt separately collected bounded read-only metadata after all
original gates. Its 390 ms guest observation and 1,605 ms retired SSH transport
preserved original custody before/after and matched that same run's runtime
control builds. The observed tuple is kernel 7.0.0-38-generic; Docker client
29.9.1/dfc520d and Engine 29.9.1/b26fb77; containerd
v2.4.2/b7a25261e029d68978bbf290df0a62fc819b3c51; runc
1.5.2/v1.5.2-0-g29dd3dc2; and Compose 5.6.0. Docker reported overlayfs, systemd
cgroup v2, rootful mode, all recorded resource capability flags and exactly
`name=apparmor,profile=default`, `name=seccomp,profile=builtin`, `name=cgroupns`.
The image remained the existing digest-pinned amd64 Bun image.

Independent origin/custody/authority/disposal review and runtime/control review
accepted both actual reports. The latter ran the pinned pure restriction,
thread and resource oracles and rejected six altered runtime records per
attempt plus four altered metadata records. Metadata's fresh allowance did not
extend historical verification deadlines. It proves tuple consistency rather
than an atomic guarantee against concurrent root administration.

The internal Doctor results correctly retained exit 4 and release-unverified
status; fixture PTY replies remain `humanConsentProof:false`. Source catalog
entries now reference the second report for exact installer/readiness evidence.
Ordinary packed verification of those entries is recorded below. No other kernel,
architecture, Debian/Arch/Desktop target, real human consent, global performance
gate or complete issue #24 acceptance is inferred.

The earlier source `0a83622d132ce782f1a3748b6656116a33a6479d` attempt remained a
failure before enrollment: its report SHA256 is
`e0b5dc27178e2238f9d9c525febd7305f5cbab1033ebffd181c7362bf49efb35`.
It installed the exact packages but rejected Ubuntu 26's sudo alternative as an
unexpected file layout. Its outer observer also reported cleanup uncertainty;
inner VM disposal did not repair that receipt. Bounded read-only diagnostics
identified the rejected predicate and provider provenance before the reviewed
sudo-rs fix. The failed history remains separate from these later successes.

Two ordinary attempts at source `ddfae43fd853acf3f3f36067138a4f10edd8a5ba`
also remain failed. Report
`42125b58b8d3f10edbaaafc3f689e902d0840ea7934e1e18b402cb52399808eb`
stopped on an unrecognized SSH boot connection close before setup. Report
`4bc4243ea9a7bab027bb6df93245fefd3a06bdd19caa874d7d8beaf722a43c81`
reached host terminal validation, which still required Ubuntu 24's ordinary
profile. The rejected final guest report was not retained; no completed ordinary
proof can be reconstructed from that attempt. Both disposed of their owned VM
and artifacts, with independent cleanup review. The corrected host profile check
was verified through the separate executions below; cleanup and later code
changes do not promote either failed report.


### Ordinary Ubuntu 26.04 packed verification

Source `bb4f145a89b9c09b0e139cf19a215c8579006367` completed two fresh owned
Ubuntu 26.04 x64 VM attempts with the source-built ordinary `fleur` package,
Bun 1.4.3, the same frozen Resolute package set and authenticated recorded
helpers. Native Intel HVF execution used CPU-host mode without fallback. The
attempts took 287.47 and 256.17 seconds. Report SHA256 values:

- `540482926dd0a1e5c32a9a78f4d44c97da289f77f380597f3e6d1d6e3271977a`
- `37721c49c7658bd6ce427b1e5cf04ba78e7048727147f6baf440a0d891a2170d`

Each independently installed all five exact packages, exercised the separate
installation-side-effect, enrollment and image authority boundaries, refused two
stale-login probes and resumed through a genuine fresh login. Both Doctor rounds
and both ready setup reprobes returned exit 0 with the exact Ubuntu 26 profile
and its existing reviewed evidence references. Smoke cleanup succeeded; package,
service, repository, unrelated-container, context and grant preservation checks
passed. Original root-attested OS and custody remained anchored across both
connections and the runtime control proof.

Each full restriction probe passed without changing its GC, idle, syscall,
thread, CPU, memory, PID or lifecycle assertions. All eight physical exits met
the original 250 ms bound: 31, 32, 30 and 81 ms in the first attempt; 59, 74, 68
and 46 ms in the repeat. The four lifecycles per run retained 30-second deadlines
and their original 10-second retirement bounds. Ordinary-user daemon metadata
matched the exact kernel, component builds, cgroup mode and security options
recorded above. All six probe resources were removed, the unrelated sentinel
was cleaned up, and each owned VM, credentials, scratch and overlay were disposed
of. Independent review confirmed exact scratch absence and outer process reaping.

Separate source/origin/custody/authority/disposal and runtime/control reviews
accepted both reports. All 23 verification-source hashes, 57 candidate provenance
entries and 83 restriction Git blob identities matched the frozen source. Pure
final-source restriction, thread and resource oracles passed; six altered runtime
records and five altered ordinary-readiness records were rejected for each run.
The private host wrapper returned diagnostic exit 4 only after these gates; the
actual ordinary Doctor/setup calls returned 0. Global/performance qualification
and real-human-consent flags remain false.

The final source passed 974 CLI/CI tests with zero failures, types, both linters
and the CLI build before native execution. These observations qualify only the
recorded Ubuntu 26.04 x64 tuple. Fresh-login handoff is not proof of interrupted
privileged-transaction recovery. Other platform installation/runtime paths and
interrupted-setup recovery remain open under issue #24.
