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

## Release gate

Authenticated artifacts may support a reviewed source-owned candidate installation plan. They must not silently promote an OS/architecture tuple to supported. Record artifact authenticity, installer execution and runtime support as distinct states. Exact source-owned plans must include authenticated dependency closure and all bundled side-effect authority; normal commands cannot accept public profile/verification overrides. Native evidence must include actual packed CLI setup, ordinary-user local daemon and Compose readiness, repeated owned smoke and cleanup, existing-tool preservation, interruption/reprobe behavior, and Fleur restriction compatibility for the exact tuple. Missing evidence remains explicitly open.
