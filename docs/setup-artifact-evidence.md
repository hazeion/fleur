# Prerequisite installer artifact evidence

Initial artifact audit: 2026-10-19, for issue [#24](https://github.com/hazeion/fleur/issues/24). That read-only audit executed no installer, package payload or application and established no native readiness. Later sections record separate native execution at exact source revisions; their scope and release admission remain explicit.

## Evidence scope

| Layer | Observed result | Remaining proof |
|---|---|---|
| Docker apt | Six signed repository indexes and all 30 exact payload SHA256/size values verified | Native package-manager execution, dependency closure, fresh setup, ordinary-user smoke and exact runtime compatibility |
| Arch packages | Four payload hashes/signatures and 5/5 master certifications per signer verified | Native pacman trust enforcement, complete consistent distro snapshot and fresh setup |
| Desktop disk images | Both exact hashes, strict image signatures and Gatekeeper notarization passed | Full application signature assessment, fresh installation, real agreement action and native daemon/runtime readiness |

The ordinary [native prerequisite workflow](../.github/workflows/native-setup.yml) jobs check existing Docker on native Ubuntu 24.04 amd64/arm64. Its explicit manual x64 KVM lane separately attempts fresh Debian qualification; an existing-runner pass does not establish fresh installation. The sections below retain actual guest and private Intel Desktop results. Other promised native targets remain open.

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

## Existing-runner daemon observations

The native setup verifier records an allowlist of daemon identity, kernel,
architecture, cgroup driver/version, security options and resource capabilities
from its own run. It checks version, kernel and architecture against that run's
server build response and rechecks daemon identity and server builds after each
packed smoke round. Info command and parse failures use fixed diagnostics rather
than copying raw daemon output. Proxy settings and labels are excluded.

These observations support reviewing exact runner tuples. They do not qualify
installation, interrupt recovery or a release profile by themselves, and new
metadata cannot fill fields missing from an older report.

## Release gate

Authenticated artifacts may support a reviewed source-owned candidate installation plan. They must not silently promote an OS/architecture tuple to supported. Record artifact authenticity, installer execution and runtime support as distinct states. Exact source-owned plans must include authenticated dependency closure and all bundled side-effect authority; normal commands cannot accept public profile/verification overrides. Native evidence must include actual packed CLI setup, ordinary-user local daemon and Compose readiness, repeated owned smoke and cleanup, existing-tool preservation, interruption/reprobe behavior, and Fleur restriction compatibility for the exact tuple. Missing evidence remains explicitly open.

## Ubuntu 24.04 Azure runner readiness, 2026-10-23

The existing GitHub ARM64 and x64 runners completed native readiness observations
and the full bounded runtime probe at source `31e5680304dec5af6963232a665caa606f8f9c58`.
GitHub tested merge `a85405dc483607ffa36b66d89f21dcd96592516c`; its tree equals that
source tree. The [native workflow](https://github.com/hazeion/fleur/actions/runs/40026921944)
passed both platforms. The [compatibility run](https://github.com/hazeion/fleur/actions/runs/40026921954)
completed both runtime jobs successfully before a later test-fixture fix
superseded the aggregate run. A cancelled aggregate is not a passing workflow.

Both tuples use Ubuntu 24.04.5, kernel `6.17.0-1022-azure`, Bun 1.4.3,
CLI `28.0.4/b8034c0`, Engine `28.0.4/6430e49`, containerd
`v2.4.1/f2551031d7276a770f65f98c9b52e57e7dad07e8`, runc
`1.5.2/v1.5.2-0-g29dd3dc2`, and Compose 2.38.2. Native reports record systemd
cgroup v2, rootful operation, `name=apparmor`, `name=cgroupns`, builtin seccomp,
and all required resource capability flags. Each preserved its context and
inventory across two packed smoke rounds and retired its unchanged sentinel.
Those historical Doctor rounds returned exit 4 with unverified release state.

| Architecture | Native readiness report SHA256 | Runtime report SHA256 |
|---|---|---|
| ARM64 | `15db2e603e2cdfccd8549aa78bcc7a1bf53a22f962012449297460608d0332e9` | `17e7c7a80b9bff706368f2d19ac52538a20bee6725abaf902ab97220d33c7c48` |
| x64 | `2c29e92c1eba819c44f33361b8ac5ba319ae9343dc9cba4e64973b304774c7fd` | `a3f687541d7438b370b8c2dcbf74d2cf8c2b7a248f385257b68d31c72eba9402` |

Independent review accepted both source-bound runtime reports using the strict
restriction, thread and resource oracles, measured GC, idle and worker lifecycle
evidence, host control, retirement and cleanup. Physical exit lateness was
71/61/29/37 ms on ARM64 and 43/15/32/32 ms on x64, below the original 250 ms limit.
Four negative report mutations per architecture were rejected. The metadata and
runtime jobs establish matching tuples across separate hosts, not one shared
daemon instance.

The compiled readiness catalog maps these exact observations to separate ARM64
and x64 entries. Ordinary Doctor/setup fixture tests require their own evidence
references and reject neighboring kernel, client, containerd and rootless values.
The [follow-up native workflow](https://github.com/hazeion/fleur/actions/runs/40029022728)
passed at source `908443e1152c1c0b7044098bf67cd3af51470c8a`. Its tested merge
`f366cdaff1f90bdf5b3851defe3c3a575f55944d` has the same tree. Both native
architectures returned verified Doctor readiness twice, preserved the correlated
daemon/build and sentinel, and confirmed owned smoke and sentinel cleanup.
Independent review accepted ARM64 report
`4f68d3904a38e2fecdf17c2504aebbcc0c8c4a07ab9c1855e5c0ecc41f24dc12`
and x64 report
`90697e649879f4c081dec6daba85f6e94224d42497723820968b31331727b743`.
The original evidence hashes remain the catalog references; these follow-up
reports confirm ordinary Doctor behavior after catalog admission.
No Docker installation, package upgrade, interrupted-setup recovery, human
consent or broader platform qualification follows from these runner reports.


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

## Ubuntu 26 interrupted APT transaction and reboot refusal

At source `cc34888a2917a324da0a3dd42e5ceabaa7ac69b1`, a disposable native
Ubuntu 26.04 x64 guest exercised the real, exact local-archive installation.
Report SHA256:
`8764020054451f34ad535a54892a6bdc45408127f873049c5551649c0d9f3b1e`.
The bounded outer observation completed in 107.89 seconds. This is interruption,
reboot and preservation evidence; successful recovery remains unqualified.

Five guest process-control conformance cases passed, including descendants born
after the parent was stopped, rapid exit, a live nested subreaper, a surviving
child and refusal before launch when the supervisor was not idle. The real
installation child remained live across the CLI stop. The owned CLI was killed
and reaped separately; adopted descendants retired. The original privileged
command's terminal outcome remains unknown. Exact configured Docker package
additions, all baseline package rows and ordinary session groups were preserved.

Doctor and setup returned `RECOVERY_REQUIRED`, exit 5, on the original boot.
A real kernel reboot retained the same owned VM, held overlay inode, continuous
QMP connection and pinned SSH key. The original machine identity and OS matched;
explicit protected transition evidence bound distinct original/current boots and
manifests. Package inventory remained exact and healthy across reboot.

After reboot, setup again returned 5. The retained `archives/partial` and
`local-lists/auxfiles` directory inodes were observed owned by UID 42. This report does not authenticate the account mapping
or the actor that changed ownership. The former remained mode 0700 and unreadable to the ordinary user; its
contents are unknown. The resolver requires original ownership and exact
contents, so this observation cannot qualify successful reconciliation. No
ownership restoration, package replay, grant restoration or administrator repair
was performed. The original artifacts and grants remained preserved.

Independent review verified the source/archive bindings, actual observations and
complete VM, credential, scratch and overlay disposal, plus outer child/group
retirement. The private resume observer reported a generic handoff error while
retaining the specific manual-recovery result; that diagnostic routing also needs
correction. Automated disposable-guest consent fixtures supply no human or legal
consent proof. Other platform installation/runtime paths and issue #24 remain
open.

## Native read-only APT inspector conformance

One owned Ubuntu 26.04 x64 VM observation at source
`e9400db90868eb90221ed2883ad38c9ffc10ccd9` exercised the production inspector
against nine separate retained-directory fixtures. Report SHA256:
`cf1ee53f6bdd9820a81b0daeb1ac2e8a1d7648e0ec827529bfd9e18aafc96209`.
Independent review verified source provenance, original installation preservation,
reboot custody and complete VM, credential, scratch and overlay disposal.

The actual root inspector confirmed the empty fixture and refused nonempty,
account-digest, parent-start and descriptor cases. The production custody factory
refused replaced-inode and symlink cases before privileged execution. A
completed native inspection whose completion was withheld from the caller retained
all five parent descriptors. A private negative control removing only that
uncertainty guard reproduced descriptor loss after the actual root read retired.
These were owned disposable fixtures; they did not inspect or repair the original
installation stage and do not prove human consent.

The same run interrupted the real package installation, preserved its five healthy
package additions, and rebooted with a separately validated current custody
binding. Setup then safely returned recovery-required before requesting inspection
authority. The five original downloaded package files were mode `0644`, whereas
cache copies and controls were `0600`. The recovery writer recorded these exact
modes, but its reader required every file to be `0600`. This run therefore remains
incomplete recovery evidence. It does not qualify assisted recovery or repeated
post-recovery Doctor, setup and runtime behavior.

The subsequent reader correction admits `0600` or `0644` only for authenticated
source package files inside their original owned `0700` directories. Cache
archives, lock, plan and configuration files remain `0600`; every current file must
still match its recorded mode exactly. A public setup regression reproduced the
native refusal before the correction and then reached the separately scoped
inspection plan. Native end-to-end recovery still requires a new observation.

## Repeated Ubuntu 26 assisted APT recovery

Two fresh owned Ubuntu 26.04 x64 VM attempts at source
`88f182f20dc371c398b670ea40353fd94702b1cd` completed the interrupted-installation
recovery path with separately scoped read-only inspection. Both used the ordinary
packed CLI, Bun 1.4.3, native Intel HVF execution with CPU-host mode, the existing
pinned image and the authenticated recorded helper pair. Assertions, deadlines,
repeat counts and disposal requirements were unchanged.

| Attempt | Report SHA256 | Outer observation |
| --- | --- | --- |
| First | `7e58375037fb22416973d54ec72fe03b82a97e4419a49c529b9e4b19ab729827` | 359.74 seconds |
| Second | `21163f4abea61773876a45c44803f17e928a84449d84cbdbb4ffebf5bda2b13e` | 359.08 seconds |

Each attempt observed a real installation child live across its owned CLI parent's
stop, then reaped that parent after SIGKILL. The original transaction's terminal
outcome remained unknown. All five exact package additions were fully configured,
with the baseline package rows and groups preserved. Same-boot Doctor and setup
refused recovery and retained the original fence and grants.

A real reboot established a different kernel boot ID while retaining the same
owned VM, held overlay inode, continuous QMP connection and pinned SSH identity.
Protected original and renewed custody bindings were independently checked. After
reboot, noninteractive setup returned exit 3 with the exact read-only inspection
plan and no new grant. One automated disposable-fixture reply supplied a separate
once inspection grant. Its receipt bound the original fence and profile, current
boot, fixed inspector source, authenticated executable, live CLI parent, protected
account database and five retained directory descriptors. The inspector confirmed
that both original auxiliary directories were empty. Their ownership and modes
were preserved; no administrator repair or historical grant replay occurred.

The durable receipt retained the unknown historical outcome. Original artifacts
and all six historical grant records remained unchanged, with exactly one new
consumed inspection grant. Setup retired the pending marker only after repeated
current-state checks. Docker access enrollment, fresh login and image acquisition
remained separate subsequent actions. Both Doctor rounds and both ready setup
reprobes returned exit 0 with smoke cleanup, snapshot preservation and unchanged
grants. Strict runtime, thread, resource and control checks also passed. Separate
specification and standards reviews accepted both actual reports, including source
provenance, custody, inspection authority, preservation and disposal. The four
physical-exit latenesses were 37/33/34/31 ms and 79/61/31/37 ms respectively, all
within the unchanged 250 ms limit.

Both guests, credentials, scratch directories and overlays were disposed, and the
outer children and inherited groups retired without timeout. Source files remained
unchanged throughout execution. This qualifies the tested completed-effects case
with a missing parent receipt and separately authorized inspection. It does not
establish automatic recovery, real human consent, other interruption windows,
other platform installations, global release admission or native performance.
The source candidate also passed all three CI workflows, including 1,064 CLI tests
with zero failures, types, full lint and the production build.

## Debian 13 x64 retained image input

A bounded artifact-only acquisition retained the immutable official
[Debian 13 genericcloud image](https://cloud.debian.org/images/cloud/trixie/20261017-2634/debian-13-genericcloud-amd64-20261017-2634.qcow2).
The [Debian cloud publication guidance](https://cloud.debian.org/images/cloud/)
specifies TLS image and checksum downloads for current per-distribution images;
this observation claims neither OpenPGP verification nor DNSSEC validation.
The authenticated HTTPS redirect selected the same image path at
`gemmei.ftp.acc.umu.se`. The original official checksum response matched its
previously recorded SHA256.

| Input property | Observed value |
| --- | --- |
| Image bytes | 342,818,816 |
| SHA512 from official checksum set | `ec584ccabfef7120b4c4f7482adf0e615894d9292cedec446b64194b951ebe5dd97c336b5dcbae458333764b0edd516334506017f33c4f2020ef8d38b569ffe3` |
| SHA256 from retained-descriptor readback | `87211f082e2983a1c2209a2626f9f6762073a92c6a63a8ce321608ca496c3b02` |
| Format / virtual size | QCOW2 / 3,221,225,472 bytes |

The worker completed and was reaped in 21.09 seconds under its original 120-second
work bound. Independent readback verified the digest and unchanged device/inode,
owner, private mode, size and timestamps. The previously audited, checksum-pinned
`qemu-img` reported no backing chain, external data, encryption or internal
snapshots and zero check errors. Independent review accepted this retained input.
No VM was booted and no Debian installation, runtime support or catalog admission
follows from these artifact checks.

The first Debian verification preparation admits only the explicit Debian 13 x64
seed and protected custody tuple alongside the existing Ubuntu targets. Original
OS bytes, boot and ordinary-user identity remain bound; crossed distributions,
releases, architectures and unknown fixture choices refuse before guest work.
This changes neither the Ubuntu default nor ordinary Debian admission. Catalog,
guest verification, boot, installation and runtime qualification remain pending.


## Debian 13 x64 internal catalog inputs

An offline audit reverified the cached official Docker key and RSA signing subkey,
Trixie InRelease, its authenticated amd64 Packages index, all five complete package
hashes/sizes, and actual control identity/dependency fields. The scoped maintainer
script ledger is 9,058 bytes with SHA256
`a9a9c699e6a73a41e15d12ecfe8d2ac29d70753ce3ca1308589bcccf32631097`.
Audit report SHA256:
`89770863773d5a7213b7b6f1d0cc34038aa2e3838c02b70f5eb00649905f101e`.
Independent read-only review accepted the signature, index, payload and control
checks. No package was extracted or executed.

The initial five-package Trixie internal catalog had SHA256
`4dd2d26f6feb18768ac8cde10302006806f4f9a91c2bde59d8f96cb4744ce8f1`.
Its legacy verified field means internal artifact admission only. Installation
remains pending and runtime support unverified. The builder and guest consumer
bind this exact catalog to Debian 13 x64; ordinary production profiles stay
unchanged. Dependency-environment readiness, native package-manager behavior,
installation and runtime evidence remain separate requirements.


## Debian 13 x64 native dependency refusal

Source `91be1c4200b3950661b5e7564aeb4d9e792eca8b` booted the pinned Debian 13
x64 cloud image under HVF with native host CPU execution. Protected Debian OS and
boot custody, pinned SSH and Bun 1.4.3 preparation passed. The observed kernel was
`6.12.113+deb13-cloud-amd64`.

The five frozen Docker packages could not satisfy the actual dependency plan:
Docker CE required `nftables`, which was absent and unavailable within the scoped
Docker repository. The simulation returned 100. Public setup returned
`PREREQUISITE_UNAVAILABLE` before package installation; package inventory,
services and groups remained unchanged. Repository configuration did occur under
its separate grant. No dependency was preinstalled or resolved outside the exact
allowed set.

The outer observation completed in 46.65 seconds without timeout. Raw report
SHA256 is `f8d4e15399b90283393891ef67047bb09bd5850a4d9916e7359179ff8ffbc745`.
Independent specification and standards reviews verified source and artifact
pairing, unchanged package inventory and complete VM, credential, scratch and
overlay disposal. The outer child was reaped with no live inherited group
members. This is failed prerequisite evidence: installation remains pending, and
fresh-login readiness, runtime, recovery and ordinary Debian admission remain
unqualified.

That source passed all applicable CI: 1,099 CLI tests, zero failures and 11,353
assertions across 59 files; native prerequisite verification; and compatibility
verification. CI success does not promote this failed native attempt.


## Debian 13 x64 declared dependency candidate

The expanded [Trixie internal catalog](../scripts/native-candidate-debian13-amd64.json)
has SHA256 `032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d`.
It retains the five Docker artifacts and separately declares these Debian packages:

| Package | Exact version | Bytes | SHA256 |
| --- | --- | ---: | --- |
| libjansson4 | 2.14-2+b3 | 39,792 | `60707a62fe6c1228c3389b12a13ca4efd76defc5532473e547a29e99cf7d2a6e` |
| libnftables1 | 1.1.3-1 | 332,448 | `c7cbee3dce8452ae5c3c4269f6f52e96b896d36a46ea3c490e0e11e8ff359896` |
| nftables | 1.1.3-1 | 75,864 | `2ddfa61baaf3a76e2c499db9e521ba6affb226f85af0b6fef739f346ac5f0c39` |

The [official Debian archive key](https://ftp-master.debian.org/keys.html)
has primary fingerprint `04B54C3CDCA79751B16BC6B5225629DF75B188BD` and signing subkey
`B8E5F13176D2A7A75220028078DBA3BC47EF2265`. Independent offline review checked the key
binding, signed Trixie InRelease with SHA256
`0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675`, and authenticated
amd64 Packages.xz with SHA256
`7778d3e3f303b7ddb8ce0fe7c8d57473a076c6bf2e8f241f75421d2396352498`.
The release snapshot is dated September 12, 2026 and has no Valid-Until field.
This establishes the retained snapshot's signatures, without claiming archive
freshness or absence of a later revocation outside the supplied key material.

Actual payload hashes, package/control fields and maintainer effects were inspected
with bounded in-memory archive parsing, without extraction or execution. The
5,854-byte controls-and-effects ledger has SHA256
`c8d9621167b75774c7fa17e07ad845afadaa405b3a38388195383f7314728f17`.
Fresh nftables installation writes configuration/helper state and reloads systemd;
the libraries activate ldconfig. Existing helper state could enable or unmask a
unit, and the packaged firewall configuration contains `flush ruleset`. Setup
therefore refuses prior nftables configuration/unit/helper state when nftables is
absent and repeats that observation before installation. No product command applies
that firewall configuration or starts the nftables service.

The native verifier adds a separate owned-fixture canary under original protected
Debian custody. It requires authenticated iptables-nft with the nf_tables backend,
creates one detached nonce chain and RETURN rule, and compares only that canary
after installation, fresh login and runtime. It also requires nftables.service to
remain inactive and disabled after installation, with zero execution timestamps
and PID. Cleanup removes only the exact owned rule and chain; uncertain failures
retain them for full owned VM disposal. These checks cannot establish universal
firewall preservation. Their actual repeated native execution remains pending,
as do installation, runtime, recovery and ordinary Debian admission.

## Debian 13 absent-package state diagnosis

A fresh disposable boot at source `77b0e1a4a8111dd966ea9e435c8fb47e88362cd1`
reproduced the package-state input behind the expanded candidate's early refusal.
The exact eight-name `dpkg-query` returned exit 1, seven unknown-name diagnostics,
and this row for the referenced but absent nftables package:

```text
nftables<TAB><TAB>not-installed<TAB>ok
```

Raw observation report SHA256:
`10cd0103dc71f908994bc0f319b6777edf8b02fbf0540a95c9ccf33f2e75f87b`.

The baseline contained no installed nftables package. This empty-version record
is distinct from retained configuration or a partial installation. The named
inventory parser and privileged archive guard had both rejected it. Setup now
classifies only an empty-version, error-free `not-installed` record as missing.
Canonical duplicate identities, foreign architecture qualifiers, retained versions,
configuration, incomplete states and uncertain query completion remain refused.
The existing nftables configuration, service and helper-state checks still apply.

This observation ran only the read-only inventory query. It requested no setup
authority and installed no packages. Protected guest custody and bounded execution
were retained, and VM, scratch and credential disposal completed. It establishes
the diagnosis only; repeated actual installation, runtime and recovery qualification
remain separate requirements. Requirements-based regressions first reproduced the
planning refusal, then the archive-hook refusal, before their respective fixes.

## Debian 13 x64 package-state fix and first installation proof

Source `5ebce058035cb8d2793dea50ce248c5579d2f56b` passed one fresh native HVF
internal-candidate run after the absent-package fix. The raw report SHA256 is
`9e98f7235725d66533bb77576ca01c6d100ea0e3ff862986c1063eeb6556983d`.
The pinned Debian image booted kernel `6.12.113+deb13-cloud-amd64` with Bun 1.4.3.
Actual installation added exactly the five Docker packages and three declared
Debian dependencies. Noninteractive and denied authority preserved the baseline;
installation, repository, service and access actions retained separate scope.
Authority responses came from the owned fixture; no human-consent proof is claimed.
Fresh-login handoff, two Doctor/setup observation rounds and the full bounded
runtime probe passed. The internal candidate continues to report release support
unverified; this is not ordinary Debian catalog admission.

The owned nf_tables canary matched before installation, after installation, after
fresh login and after runtime verification. After installation, nftables.service
stayed inactive, dead and disabled with zero execution timestamps. Canary cleanup and VM, overlay,
scratch and credential disposal completed. Independent review verified the exact
source/catalog pairing, eight-package delta, runtime controls and disposal.

A second attempt refused before VM creation because required historical host-tool
attestation files were unavailable. It did not repeat installation or establish a
second native pass. Repeated installation and interrupted recovery remain open;
no missing attestation check was removed, and no release profile was promoted.

## Native macOS placement repeats after the package-state fix

Source `86849ab70392b3c2585e987ab54ea058005754b0` completed two actual native
Intel macOS 15.7.7 placement runs with Docker Desktop 4.96.1 build 244132.
The authenticated official image SHA256 was
`3d35634cf3dd0373d37d986de10eb744950d3822124615e774335f7be2a1d27a`.
Both runs used the existing public explicit 600-second setup option and the same
reviewed private fixture plan; elapsed times were 230.245 and 182.102 seconds.
Receipt SHA256 values are respectively:

- `df1f8f9403cb9d93abd5bee2a84804af9101ecef1635f4b1b8a1e6149de57be0`
- `9d93ece1bd181d4a20f4d88e764f223beefffd124f1c9513e51359e440df4363`

Each fixture simulated only missing CLI discovery and supplied two scoped once
responses for acquisition and placement. The signed image download, mount,
notarization/signature checks, staged copy, publication identity and normal detach
were real native operations. All 14 native commands completed and their process
groups retired; source cleanup completed, with no timeout or cancellation. Both
receipts passed independent review. Placement used a fresh private Applications
destination and retained its installed app. Existing Docker.app metadata and
recorded core-file snapshots matched exactly before and after each run.

Public setup correctly stopped at `HUMAN_ACTION_REQUIRED` after placement. These
runs establish fresh private placement and cleanup; they do not establish human
consent, helper installation, legal acceptance, launching the new app, a fresh
host-wide Docker Desktop installation or release admission. A separate native
existing-installation verification at the same source passed two Doctor/runtime
smoke rounds and preserved and removed its owned sentinel. That readiness proof
used the already running Docker Desktop installation, without acquisition or
installation, and remains separate from the placement receipts.


## Exact Intel Desktop installation-method admission

The fixed packaged `verified-desktop-profiles.json` record binds native Intel
macOS 15.7.7 to the official Docker Desktop 4.96.1 build 244132 artifact, the
successful authentication report and the two reviewed placement receipts at
source `86849ab70392b3c2585e987ab54ea058005754b0` above. The loader validates exact
schemas, artifact/host consistency and distinct repeat hashes, then freezes the
records. This source-owned installation authority is separate from the existing
APT catalog; no CLI, project or environment profile override is introduced.

Here `nativeEvidence: verified` means the placement method was observed natively.
The record explicitly sets `runtimeReadinessAdmission: false`. Agreement, startup,
helpers and configuration remain separate human actions; successful placement
still returns resumable `HUMAN_ACTION_REQUIRED`. Other macOS and architecture rows
remain unverified. Requirements-based red/green tests show the ordinary default
catalog now exposes separate acquisition/placement authority for this exact tuple,
with no grant creation or OS mutation on JSON invocation. Malformed or inconsistent
catalogs fail closed.

## Ordinary packaged Intel Desktop placement repeats

Source `9d74daa7bfbf0fdd863e68361628e2d3d3fde47e` completed two fresh native
private placements through the ordinary `fleur` package and its default compiled
catalog. The archive SHA256 was
`4b9c43eca03839d1c1a178506d9cb25eb11a5770e4cf20a290ad1aa1a2c5ac9b`;
all 66 packaged files matched their committed source bytes. No profile or
readiness override was supplied. The fixed reviewed plan SHA256 was
`e93163ff57b15ed0f9280b883be06810f7b8b24a4f588195603cada16675f049`.
Receipt SHA256 values, in order, are:

- `683a6188dc3894a95aa886a1c0d4c59d61d47433df1d89d7d8ac129f704ddd01`
- `9303f682d4c26566ee613e5c3cd468b89431f37ff431a5895b892e91c3f407ba`

Both runs passed independent review. They finished in 181.104 and 188.066 seconds
within the original explicit 600-second budget. All 14 native commands completed,
with verified process retirement, signed staged/published app identity, normal
image detach and empty installer scratch. Separate once grants were consumed and
revoked. Existing Docker.app metadata and recorded core-file identities and hashes
were unchanged across both runs. Each private destination retained its installed
app. Public setup returned the expected resumable `HUMAN_ACTION_REQUIRED` after
completed installation and cleanup.

This verifies ordinary-package routing for the exact Intel placement method.
The fixture simulated missing CLI discovery and supplied scoped authority
responses. It does not establish human consent, helper installation, legal
acceptance, launch of the newly placed app or runtime-readiness admission.

## ARM VFS cleanup failure and targeted retry

At source `9d74daa7bfbf0fdd863e68361628e2d3d3fde47e`, the first
[ARM VFS attempt](https://github.com/hazeion/fleur/actions/runs/40078009667/attempts/1)
passed runtime controls but failed physical data-root removal within the existing
cleanup budget. Its report SHA256 is
`806d0eb8838543626de562f67179aa05d5af24fbbb990a1ca3d1170da58e5150`.
Task, shim, daemon and owned-mount checks had completed; cleanup did not report
completed root removal. Independent review found no faulty assertion or safely
removable duplicate work. This attempt remains failed evidence.

One unchanged-source, failed-job-only retry passed the original full probe and
all cleanup checks. Its report SHA256 is
`a1b5fd5baa672aa87b8c85f99d4edb12150abd8ed82151ed78c3a6f4316c6354`.
The owned process was reaped, socket and pidfile removed, both roots removed and
the default daemon unchanged. No deadline or assertion changed. The current
candidate's CLI, native prerequisite and compatibility workflow summaries passed.

## Hosted Debian containment collection race

The first guarded hosted attempt at source `e7f1ad1` refused a direct run-as-group
query before preparation or VM creation. Source `9d74daa` instead proved root KVM
API access and passed its normal managed-service containment case, but then
[refused during its stop self-test](https://github.com/hazeion/fleur/actions/runs/40079319762).
The exact transient unit had been collected between its state query and the stop
command. No package preparation or VM creation ran; all owned service cgroups
were absent and scratch removal completed.
The refusal report SHA256 is
`e082eb2a086363e1688fd882e361bb49d9f1ff95ce43eb408af05e89784eb014`.

A regression reproduces the state-query/stop race. A stop result indicating an
unloaded unit is accepted only after a new valid not-found observation and absence
of the retained exact cgroup. Other status codes, live groups, changed invocation
and unavailable metadata still refuse. Cancellation remains latched, and terminal
receipt binding and final disposal checks remain required. This is a verifier
control fix, not Debian installation or release-admission evidence.

The next exact Debian internal-candidate verifier also records sanitized daemon
capabilities, security options and component builds before and after the unchanged
repeat/runtime gate. Each capture validates and hashes the daemon identity around
the bounded info/version queries; incoherent versions or architecture, unknown
security options and changed observations refuse. Private daemon metadata and raw
identity are not published. This records identity and tuple stability, not daemon
process continuity across restarts. It does not admit a readiness profile. The
first native Debian report omitted these fields, so they must be measured in a new
native run before using them as release evidence.

The [hosted attempt at source `ee0c26d`](https://github.com/hazeion/fleur/actions/runs/40082201706)
passed all four containment controls and ordinary-user KVM access, then installed
the exact 18-package test-tool closure. Other packages and host Docker state were
unchanged. It refused the final verifier service's startup binding before opening
the execution gate. The report omitted the mismatched field, so the cause remains
unclassified. Owned service disposal and scratch removal were unconfirmed; this
is failed evidence. Report SHA256:
`aeab8a130c45be3f85a4f7615b0da776b6cd8a7a78c408302866df790c3e10c0`.

Startup regressions independently exposed two verifier defects: a valid
`Type=exec` process could be rejected while still activating, and a two-second
budget incorrectly accepted `0min`. Startup now retains cleanup-only authority
after the exact immutable identity and root-managed cgroup checks pass, waits
within the original 20-second startup deadline for that same invocation and PID
to become active, and opens the gate only then. Changed identity, invalid controls,
cancellation and a persistent activating state still refuse. Duration forms must
represent the exact budget. Binding failures now include bounded field-level
diagnostics; this does not establish the earlier hosted failure's cause. Every
unwaited launched client receives terminal/disposal verification even if it has
already exited. Unknown service custody remains refused.
The original predicates fail the startup, exact-duration and exited-client
regressions for the intended reasons. Independent review passed all 20 Python
contracts. The affected Bun wrapper and catalog tests passed six tests with
49 assertions; strict types, both linters and the Bun production build passed.
These local results do not replace a new native attempt.

## Hosted Debian installation and image-bound repeat

Source `bc2a1668b7e60d5dd66b8f01065a436f3241876b` passed all three full PR
workflow summaries. CLI passed 1,241 tests with 12,051 assertions, types, lint and
generated-project checks. Both native runtime probes and VFS physical-cleanup
checks passed. Its [first hosted Debian KVM qualification](https://github.com/hazeion/fleur/actions/runs/40083092762/attempts/1)
also passed independent review. Report SHA256:
`828b1ab3680131cae853e2766188b17da6b87896de7f92f776caf6bce25a46b8`.
The exact eight-package installation, fresh-login handoff, two Doctor smoke rounds,
full runtime restrictions, owned firewall preservation and complete VM, overlay,
credentials, scratch and service-cgroup disposal passed. Doctor still returned
the expected release-unverified result for this internal candidate.

The report now records the actual stable Debian 13 x64 daemon tuple: Docker
29.9.1, kernel `6.12.113+deb13-cloud-amd64`, systemd cgroup driver/version 2,
rootful operation and the default AppArmor, seccomp and cgroup namespace options.
This supplies the fields missing from the earlier report, without admitting an
ordinary profile or claiming daemon process continuity.

The [x64-only fresh repeat](https://github.com/hazeion/fleur/actions/runs/40083092762/attempts/2)
refused a changed runner image before package preparation or VM creation; owned
services and scratch were disposed. Refusal report SHA256:
`1494b6754972fcb8d9f1ae0bdf9967ad7be7a173086644d1991a121c17ac719a`.
Its collector recorded image `20261023.334.3`. Independent review compared both
read-only inventories: identical collector source, healthy 1,211-package state
hash, kernel, Docker baseline and exact 18-package install/configure simulation.
No upgrades or removals were proposed. Inventory SHA256 values are
`6c8d4c41067035bc8fb8b3fb4d78d950866c8ccfc4394211292cb56aeb223c38`
and `59c91a9ef5576f8622a6e35294645dc9b9c5908cb8b7f188d1071dc468034f9c`.
The test-tool manifest now records those exact two reviewed images and their
inventory bindings. Unknown images remain refused, and live package-plan,
baseline, actual-delta, Docker-preservation and disposal checks remain required.
The refused attempt is not a repeat qualification pass.

## Recurrent ARM cleanup diagnostic

Source `9b3076554f13b8a608991a6e420d10e29c657c86` passed all 1,237 CLI tests
with 11,999 assertions, types, lint, generated-project verification and native
readiness. Its ARM VFS runtime probe exited successfully, but physical root
removal again failed within the original cleanup budget. The failed report SHA256
is `edf72ff1b40101edcee9592cb5b9f30f92f1f1b8032856db5f30145127ab1cbc`.
No fresh Debian attempt ran after this required CI failure.

Source `ee0c26d` adds bounded numeric progress inside the existing
descriptor-anchored removal. It records normal/fallback attempt, data/exec inode,
phase, elapsed time, successful unlink/rmdir counts and syscall durations. It does
not walk the tree before deletion, publish filenames or exception text, change the
removal algorithm, raise the 15-second cap or alter cleanup acceptance. Journal
failure does not interrupt physical deletion; malformed diagnostics are marked
separately. The recurrence remains failed evidence and is not explained by an
unmeasured performance claim.

The instrumented ARM job at source `ee0c26d0fe2f919eafbb097d9462a08bf8a361d7`
[passed the original probe and cleanup checks](https://github.com/hazeion/fleur/actions/runs/40081644190/job/120836289200).
Its counterfactual report SHA256 is
`61314fb3b17b85b16789d41618dc2dd94c64d720948ee76d55d14a7bea27fa90`.
The data tree required 90,759 successful unlinks and 11,995 directory removals,
finishing in 4.293 seconds. Unlink calls accounted for 3.548 seconds and directory
removal for 0.152 seconds; the longest observed operation took 0.163 seconds.
The exec tree also completed, both roots were physically absent, the owned
process was reaped and the default daemon remained unchanged. The journal was
complete and valid. These measurements describe this successful run; they do not
establish why either earlier run exceeded its budget or justify a deadline change.

## Retained Arch cloud-image authentication

A fresh independent review authenticated the retained official
[October 1 cloud image](https://geo.mirror.pkgbuild.com/images/v20261001.604814/)
against the current [Arch image publisher key](https://github.com/archlinux/arch-boxes#releases).
The 578,080,256-byte image SHA256 is
`360f0fa49db6813bdc8e35bed230a2dc2ae3567b7b5ab74719c0a706e4e34e87`.
The review verified the primary self-signature, signing-subkey binding and embedded
cross-signature, key flags and validity dates, and both checksum/image detached
signatures. The signing subkey expires May 28, 2027. Current publisher README bytes
matched the retained key source. The held image identity, size, permissions and
hash were stable during verification.

Independent review helper SHA256:
`982feabfd40ce012c76acccbcb1961d3aef917763663714270c00102e9560f85`.
Report SHA256:
`26e1dd7c99d320c53881580bbdf6e52ab92d26a0524316754df6efa7ed97d8f3`.
The historical parser source is missing and its attestation was not recreated.
This is fresh input-authentication evidence, without a claim of global revocation
absence. No image structure check was rerun, no VM or installer executed, and no
native Arch support was admitted. Launch still requires reviewed source-owned
custody and structure checks under an available attested toolchain.

## Debian candidate repeats and ordinary catalog admission

Source `300cdaf30e1ea4786b096786e458f698984fe038` passed all three full PR
workflow summaries, including both native runtime and VFS cleanup platforms.
Its [first fresh Debian KVM run](https://github.com/hazeion/fleur/actions/runs/40084282519/attempts/1)
and [x64-only fresh repeat](https://github.com/hazeion/fleur/actions/runs/40084282519/attempts/2)
both passed independent review. Report SHA256 values:

- First: `6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e`.
- Repeat: `5900a5954f240b9c3a85b1cfdb8636eba812b497b6a5e4a1e4c6b625e377c543`.

Each fresh VM installed exactly the five Docker packages and three Debian
libraries/helpers, preserved every original package and the disconnected owned
firewall canary, retained an inactive, disabled nftables service with no execution,
completed genuine fresh-login enrollment and two smoke rounds, and passed the
full original bounded runtime restrictions. VM, credentials, overlay, scratch and
service-cgroup disposal completed. The stable measured daemon tuple matched
across both attempts; nonce and daemon identity differed between fresh VMs.

The ordinary catalog now maps only this exact Debian 13 x64 package closure and
measured readiness tuple to the first report. The complete canonical installation
profile SHA256 is
`588ab6035cc9ff24d0591cd10a0fe3c066f092f7bdf297610907ce4835289983`.
The ordinary guest verifier requires the complete closure, original Debian OS,
matching source-owned evidence, repeated Doctor/setup success with grants and
state preserved, and all existing canary, restriction and disposal checks.
Duplicate metadata fields, altered payloads/dependencies and crossed OS/evidence
bindings are refused before installation authority. The fixed hosted wrapper now
selects the actual ordinary packed archive and checks its package/hash identity.
These changes prepare the next native ordinary run; no ordinary-package or
Debian interrupted-recovery success is claimed yet. ARM installation, Apple
Silicon and native Arch qualifications remain separate outstanding requirements.

The full local macOS test run also exposed a stale packed-executable oracle: it
expected manual setup on every non-Ubuntu host, despite the already admitted
Intel Desktop method. Actual setup correctly refused to replace the existing
Docker application. The corrected test gathers host facts before setup, matches
only exact packed catalogs, and requires the specific platform, unknown-package,
missing-identity, existing-application or separate-authority result. It never
chooses an expectation from setup's response or accepts multiple exit codes.
Existing application entry identity/metadata and empty grants are checked.
Independent verification passed all eight packed tests with 85 assertions. This
corrects test logic; no product setup refusal changed.

Before ordinary native dispatch, a final producer/consumer review caught a report
nesting mismatch in the outer wrapper: archive kind/hash are top-level, while
package name and compiled catalog evidence belong to the guest execution record.
The original synthetic wrapper proof had invented a top-level package name.
A test using the actual report shape failed before the fix. The wrapper now checks
the guest kind, package and catalog alongside the independent outer archive hash;
wrong guest kind/package/catalog still refuse. All 21 wrapper contracts passed.
The waiting dispatch was stopped before VM creation, and superseded PR workflows
were cancelled. Those cancelled workflows are not passing candidate evidence.

## Debian 13 x64 ordinary fresh qualification

The actual ordinary package at source
`5f5e13e768117f33160e5fef6eabfabb309c682d` passed two independent fresh KVM
runs in [manual run 40086384817](https://github.com/hazeion/fleur/actions/runs/40086384817),
attempts 1 and 2. Both used ordinary archive SHA256
`c0fe9b56d930db163acb102435c77100ac13084c426ed6d7e26da1922f211c4e`.
Independent review accepted these report hashes:

- First: `2210599daca9df88b3f4f794445dfe389d19d8623d24be5e9e6d6f33052eed50`.
- Repeat: `2b5c1dd9fc1c22db5b6af1a801e18848029e8323278c448df260a243e2a2cdb6`.

Each installed the exact eight-package closure, preserved original packages and
account groups until separate enrollment, refused both stale sessions, completed
a genuine fresh login and separate smoke-image acquisition, and passed two
Doctor rounds and two ready setup reprobes with snapshots/grants preserved.
All four firewall canary observations and explicit cleanup passed. The nftables
service stayed inactive, disabled and unexecuted. Full original runtime,
restriction, sentinel and disposal requirements passed. Physical pause observations
were 59/66/53/67 ms and 31/68/30/28 ms, below the unchanged 250 ms limit.

All three applicable CI workflows passed at that source, including 1,267 CLI
tests and 12,150 assertions, types, full lint, generated-project checks, both
native architectures, both macOS fixture architectures and all compatibility
jobs. This qualifies Debian x64 fresh ordinary installation only. It does not
establish Debian interrupted recovery or the remaining native platform matrix.

## Debian interrupted-recovery verifier preparation

The fixed recovery lane uses the ordinary Debian package and recorded helper
pair on the existing hosted x64 KVM runner. It exercises completed installation
effects with a missing parent receipt, preserves the historical outcome as
unknown, performs a real reboot of the same held VM/overlay, and requires
separate read-only inspection authority before fresh-login and runtime checks.
The original host aggregate deadline remains 900 seconds across these phases.
The authenticated same-boot access checkpoint retains its original guest
deadline; a later SSH connection cannot reset it.

Four-column package observations retain real dpkg status and error flags before
installation and after interruption/reboot. Exactly the eight declared effects
may differ. Persistent nftables configuration, unit/helper state and service
nonexecution are compared across the reboot. Kernel firewall canaries have
separate boot-bound ledgers: the first chain must be explicitly removed before
reboot, and a newly owned chain is created before reconciliation. No continuity
of volatile kernel rules across a reboot is claimed. Failed observations remain
failures even when full owned VM disposal succeeds.

The source record binds the exact seven staged qualification files, tracked
source commit and actual ordinary archive hash. Every guest continuation
reauthenticates those inputs against the host-held record digest. Mocked contract,
bridge, source and deadline tests are verifier evidence only. Native recovery
qualification still requires executed reports and independent review.

The first recovery attempt at `496f86f19a54d17b3feb6864b82845d08da93d75`
failed during the initial session in
[run 40089712304](https://github.com/hazeion/fleur/actions/runs/40089712304).
Report SHA256 is
`cc8f4687b8e93bb70aff286cfbd36dd273b8dadb0464f74b24a6f9c9e0b53b2b`.
VM, credentials, overlay, inner/outer scratch, service cgroup and unit disposal
were confirmed. The initial transport discarded the guest's failed report and
retained only a generic checkpoint error, so that attempt does not establish its
underlying guest failure. The transport now preserves the exact bounded parsed
report under `initialGuest` while keeping failure and refusing a successful
checkpoint; its external SSH regression failed first and then passed.

A separate descriptor-bound audit rechecked the exact authenticated nftables
payload SHA256 above and found a verifier assumption inconsistent with its tar
metadata: `/etc/nftables.conf` is root-owned regular mode `0755` (243 bytes),
while `/usr/lib/systemd/system/nftables.service` is mode `0644` (458 bytes).
The recovery reader and validator now require those exact path-specific modes.
They refuse swapped modes and retain all ownership, link, byte, identity,
configuration-preservation and service-nonexecution checks. Independent tests
execute the generated root reader and prove both exact mode requests. This is a
confirmed verifier correction, without claiming it caused the earlier native
failure whose guest diagnosis was lost. Fresh native recovery remains pending.

The next candidate, `eca5b04e5ec3b718c9572db96faa62167a06806f`, passed
all three applicable CI workflows, including 1,270 CLI tests and 12,175
assertions, types, full lint and all four independently reviewed runtime reports.
Its native recovery attempt in
[run 40090657614](https://github.com/hazeion/fleur/actions/runs/40090657614)
failed after reboot. Report SHA256 is
`eb758b47a03774982853d82742a1e4b53d6e238e2dab28fd8a2f8b16d4259709`.
The initial interruption, exact eight package effects, original canary cleanup,
same-VM reboot custody and persistent configuration preservation passed.
Doctor correctly required recovery. Setup then refused reconciliation before
offering inspection authority, retaining the pending transaction and grants.
Full VM, overlay, credential, scratch, service cgroup and unit disposal passed.
These are partial observations, not accepted recovery qualification.

Read-only diagnostic observations now record the actual packaged host's lock
verdict, fixed lock-file metadata, bounded kernel lock inventory, package health
and service provenance around reconciliation. Both custody checks and all
observations share one 20-second deadline within the original aggregate budget.
They neither repair host state nor change any acceptance decision. Independent
protocol tests and direct reconciliation tests exercise unknown/busy lock refusal,
native-shaped retained packages and separate inspection authority. The native
cause remains unconfirmed until a new executed report identifies the refusal.

Candidate `3a6f88fe5b6143ec3f252213f1d797a4383027b1` passed all three
applicable workflows, including 1,275 CLI tests and 12,227 assertions. Independent
review accepted both prerequisite reports and all four runtime reports with the
original enforcement, repeats, deadlines and disposal gates. Runtime review
summary SHA256 is
`47be5c50b24fba30f93eebdc5d9ea410352e470195cda2ae67fdedc92661ebc1`.
Its [native diagnostic run](https://github.com/hazeion/fleur/actions/runs/40091959632)
again refused reconciliation after the completed interruption and real reboot.
Report SHA256 is
`d43d64ccc0212d4196531621857e01aecd47fb08a577cdbd1208ee35a1de741b`.

Both observations identify the same blocker: `/var/cache/apt/archives/lock`
returns `ENOENT`, so the observer returns `unknown`. The other three lock files
are protected root-owned regular single-link files. Kernel lock records parse
and name unrelated inodes. All eight package versions and the full 330-row
healthy inventory match, and service provenance passes. No administrator
restoration was performed; recovery remains unqualified.

The lock observer now permits only that fixed archive lock to be absent. It
requires an existing root-owned, non-writable directory ancestor chain, stable
identities before/after the bounded kernel observation, and repeated exact
`ENOENT` for the lock. Other missing locks, permission errors, unsafe paths,
identity changes, malformed kernel records and actual contention still refuse.
It never creates, acquires, removes or repairs a lock. The focused regression
first reproduced `unknown` for the native-shaped absent lock before the fix.
Fresh execution of the corrected product is still required.

Independent review confirmed the native blocking gate, original interruption
ledger, real reboot custody, configuration preservation and complete disposal.
Seventeen focused lock/reconciliation tests passed with 156 assertions,
including an actual reconciler regression demonstrated red against the original
observer. An additional focused APT payload/recovery run passed 191 tests with
5,744 assertions. These local results do not establish later native recovery
predicates or replace the required fresh repeat.

All three applicable workflows passed at correction
`7347cad25565f493cc12541c247a0c8b204534bf`, including 1,288 CLI tests and
12,341 assertions. Independent review accepted both prerequisite and all four
runtime reports. The [fresh recovery attempt](https://github.com/hazeion/fleur/actions/runs/40092857273)
still refused after interruption/reboot, with the lock verdict remaining
`unknown`. Report SHA256 is
`3a7c2dfe563a225b6691bb7ec70966165fcb1e49560c29a04ac03268914fb7d0`.
The three existing locks are root-owned mode `0640`, healthy package state and
service provenance pass, and complete disposal passed. The report did not
include ancestor metadata needed to identify which new custody condition
refused. Read-only observations now include all five fixed ancestors and actual
directory type. No further product policy is changed before those facts are
measured. Recovery remains unqualified.

The nine-path [diagnostic run](https://github.com/hazeion/fleur/actions/runs/40093201571)
at `f9fd4e4d89d50a8c1de730e0260ddc07ac8cdd8a` establishes that the fixed
archive directory `/var/cache/apt/archives` itself is absent. Both observations
return `ENOENT` for it and its lock. `/`, `/var`, `/var/cache` and
`/var/cache/apt` are root-owned actual mode `0755` directories with unchanged
identities. Report SHA256 is
`8b59c72cdd0dbefe032b59730a2f2a0bcf45db2636871a789adb34624b26cd90`.
The first correction's requirement for an existing archive directory therefore
still refused the measured minimal-host layout. Superseded diagnostic PR runs
were cancelled and are not passing evidence.

The observer now permits only that final archive directory to share the lock's
exact observed absence, anchored by the four existing protected ancestors.
Both absences and every existing identity are checked again after the kernel
observation. Higher missing ancestors, all permission/traversal errors, unsafe
directories, appearance/disappearance races, contention and malformed kernel
evidence still refuse. It creates neither path. Independent intended-red tests
reproduced this second condition before the correction; the actual reconciler
tests retain separate inspection authority and refusal before health checks for
busy locks with both native-shaped absent layouts. Fresh native execution and
all applicable final-candidate checks remain required.

## Debian 13 x64 ordinary assisted-recovery qualification

At `7b5be60c1132ea9e758a64cd88c470798adc90b6`, all applicable
[CLI](https://github.com/hazeion/fleur/actions/runs/40093562546),
[native prerequisite](https://github.com/hazeion/fleur/actions/runs/40093562540)
and [compatibility](https://github.com/hazeion/fleur/actions/runs/40093562522)
workflows passed. CLI recorded 1,293 tests and 12,401 assertions, plus types,
full lint and two isolated generated-project checks. Independent review accepted
both prerequisite and all four runtime reports with the original enforcement,
repeats, deadlines and disposal requirements intact.

The [first fresh recovery run](https://github.com/hazeion/fleur/actions/runs/40093570538/attempts/1)
and [targeted fresh x64 repeat](https://github.com/hazeion/fleur/actions/runs/40093570538/attempts/2)
both passed full independent review. They executed the same ordinary archive
SHA256 `23530dce2b1678cb8864fbccfaa4bbbca357b36c221b117b5ae12db12504dfe0`.
Report SHA256 values are:

- First: `708068b560e3a4c5584f61f19a15e8ebcd36993be05fcb43af3d1789dd5b9fdd`.
- Repeat: `0dcdb3ead5c0327d874a92380266d9b2ff9d2cc9fbd4840bfa3987e0099bfad8`.

Each preserved all original packages and sources, installed exactly eight
declared effects, retained the same-boot fence, and completed a real reboot under
continuous VM/QMP/overlay/SSH custody. Both boot-bound firewall/configuration
ledgers passed. Historical grants and retained artifacts stayed unchanged;
separate once read-only inspection authority was consumed and revoked. Genuine
fresh login, separate smoke-image acquisition, two Doctor rounds and two ready
setup reprobes passed with state/grants preserved. Full original runtime and
VM/overlay/credential/scratch/service/cgroup disposal checks passed. Physical
pause observations were 42/27/34/29 ms and 28/78/35/45 ms, below 250 ms.

The repeat used distinct VM nonces, all boot/manifest identities, service
invocations, operations and inspection grants. Artifact 12559983657 was bound by
its published ZIP digest and creation time to the actual repeated x64 job. A
name-based download returned the first report and was explicitly excluded.
Carried-forward ARM/scope jobs were not counted as new executions.

This qualifies separately scoped read-only assisted recovery for the measured
Debian x64 ordinary package. The historical interrupted transaction outcome
remains unknown; automatic recovery and human consent are not claimed. It does
not complete ARM fresh installation, Apple Silicon or Arch qualification.

## Fixed Arch boot observation contract

The manual native workflow has a false-default read-only Arch x64 KVM selector.
It uses the fixed official cloud image `v20261001.604814`, 578,080,256 bytes,
SHA256 `360f0fa49db6813bdc8e35bed230a2dc2ae3567b7b5ab74719c0a706e4e34e87`.
The retained independent image-origin review is bound by report SHA256
`26e1dd7c99d320c53881580bbdf6e52ab92d26a0524316754df6efa7ed97d8f3`
and review-helper SHA256
`982feabfd40ce012c76acccbcb1961d3aef917763663714270c00102e9560f85`.
This does not recreate the missing historical parser attestation or establish
current global revocation absence. A fresh full-byte authentication and exact
header precheck precede QEMU interpretation; protected hosted tools then perform
read-only image information and structure checks.

The observation preserves the image's original 2 GiB virtual disk, disables
cloud-init partition/filesystem growth, and performs no package installation,
service execution or firewall mutation in the guest. The raw root OS record
retains literal `VERSION_ID` absence as `versionId: null`, with
`buildId: rolling`. Existing Ubuntu and Debian manifest records remain unchanged.

Nineteen fixed queries collect package, backend, configuration-policy, storage,
service and ownership facts. Configuration contents, mirrors, environment and
keys are not published. Failed package queries are retained as failed facts;
only complete exact C-locale not-found rows establish package absence. Each
query retains its actual outcome and process retirement under custody checks.
The original 180-second initial boot and 900-second aggregate limits remain.
Live KVM, continuously held VM/QMP/overlay/SSH identities, tracked source hashes,
all observations and complete guest/host disposal remain acceptance gates.

This lane always declares installation, native qualification, runtime admission,
human consent and native CPU-performance proof false. A successful observation
would supply measured preparation inputs. It cannot admit an Arch installer
profile or replace fresh-installation and runtime qualification repeats.

At `6842bbf0efffbc3f329cb5d65bb6c2e29b4cfbc7`, full
[CLI](https://github.com/hazeion/fleur/actions/runs/40096304681),
[native prerequisite](https://github.com/hazeion/fleur/actions/runs/40096304682)
and [compatibility](https://github.com/hazeion/fleur/actions/runs/40096304654)
workflows passed. CLI recorded 1,300 tests and 12,431 assertions, types, full lint
and two isolated generated-project checks. Both existing-install prerequisite
reports and all four runtime/VFS reports passed independent review with original
enforcement, repeats, deadlines and disposal intact. The prerequisite reports
constitute existing-install readiness, not fresh installation.

The [first guarded Arch observation](https://github.com/hazeion/fleur/actions/runs/40096309335)
failed after authenticated image/header/QEMU structure checks and actual VM
creation. Report SHA256 is
`5854bd350c091288a9dcc1471c91a31b06d7981eada2abe2e3487c61790a50b5`. Its final boot observation retained an empty SSH exit 255 with the
exact owned-loopback connection-closed diagnostic, normal process exit and
confirmed transport cleanup. Boot readiness, root custody and Arch installation
were not established. The historical close cause remains unknown. Full
VM/overlay/credentials/scratch/service/cgroup disposal passed. Exact host-tool
additions and unrelated-package/default-Docker preservation were measured through
preparation; the failed path did not collect a final after-guest host snapshot.

The correction treats only that exact empty, normally completed, unexpired
closed-loopback response as pending. Different ports/addresses, output, extra
authentication/host-key diagnostics, other exits/signals, cancellation, expired
attempts and uncertain cleanup remain failures. A later clean cloud-init result,
exact nonce and root custody are still mandatory within the original 180-second
boot limit. Permanent closes time out. Intended-red exact-message regressions
preceded the correction. Final host observations now run after service retirement
on failed guests too, retaining the primary failure and refusing changed or
unconfirmed host state. Console diagnostics expose only fixed pattern names,
line indices and hashes, preserving bootstrap secrets and making no causal or
readiness claim. A fresh corrected observation and current-source checks remain
required.
