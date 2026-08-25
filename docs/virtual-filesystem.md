# 브라우저에서 가상 파일시스템(VFS) 구현하기 — 탐색 노트

> wc-exe가 "디스크 I/O 없이 브라우저 메모리 안에서 빌드"를 어떻게 계속 실현할지, 그리고 QEMU-wasm 같은 방향이 실제로 어떤 의미인지 정리한 문서.

## 1. 우리가 진짜로 원하는 것

현재 wc-exe의 핵심 가치는 파일시스템 그 자체가 아니라 **보안 소프트웨어의 실시간 파일 스캔을 우회하는 것**이다. `npm install`이 수만 개 파일을 디스크에 쓰는 순간 백신이 전부 스캔하면서 I/O가 폭발한다. 그래서 파일을 **로컬 디스크가 아닌 브라우저 메모리에만** 존재하게 만들고, 결과물(`dist/`)만 마지막에 디스크로 내린다.

지금 이 역할은 StackBlitz의 **WebContainer**가 담당한다 (`src/runner/src/main.ts`). WebContainer는 두 가지를 한꺼번에 제공한다:

1. **가상 파일시스템** — `webcontainer.mount(tree)`, `wc.fs.readFile/writeFile/readdir`
2. **실행 런타임** — 브라우저 안에서 도는 Node.js + 셸 (`webcontainer.spawn('npm', ['install'])`)

"브라우저에서 가상 fs를 구현한다"는 질문을 제대로 풀려면 이 두 축을 분리해서 봐야 한다. **파일을 담는 저장소(VFS)** 와 **그 위에서 프로그램을 돌리는 실행 엔진**은 별개의 문제다. WebContainer는 둘을 묶어서 독점 API로 제공하는 것뿐이다.

우리가 WebContainer 의존을 벗어나고 싶은 이유(있다면):

- 독점/폐쇄 API, StackBlitz 인프라(부팅 시 원격 리소스) 의존
- COOP/COEP 크로스오리진 격리 헤더 강제 (이미 Hono 서버가 붙여줌)
- Node 버전·바이너리 제어 불가, 네이티브 애드온 빌드 제약

---

## 2. 접근 방식의 스펙트럼 (에뮬레이션 깊이 순)

아래로 갈수록 "진짜 컴퓨터에 가까워지고" 무거워진다. wc-exe에 필요한 건 _어느 층까지 내려가야 하는가_ 의 판단이다.

### 계층 A — 순수 JS 인메모리 VFS (저장소만)

**`memfs`, `ZenFS`(구 BrowserFS)** 같은 라이브러리. Node의 `fs` API를 JS로 에뮬레이트한 인메모리 트리다.

- ✅ 가볍고, `fs` 인터페이스가 그대로라 기존 도구에 끼워넣기 쉽다.
- ✅ ZenFS는 백엔드가 플러그블 — `InMemory`, `IndexedDB`, `OPFS(WebAccess)`, `localStorage` 등을 갈아끼운다. 즉 **저장 위치를 메모리↔영속으로 선택 가능**.
- ❌ **실행 엔진이 없다.** 파일을 담을 뿐, 그 위에서 `npm`·`node`·`esbuild`가 돌지 않는다. `child_process.spawn`이 없다.

→ 이것만으로는 wc-exe의 "빌드"를 대체 못 한다. 다만 **캐시/스냅샷 계층**으로는 매우 유용하다 (§5).

### 계층 B — WebContainer (현행)

계층 A의 VFS + 브라우저용 Node 런타임 + 셸을 합친 완제품. 지금 쓰는 것. "가상 fs를 직접 구현"의 반대편 극단 — **남이 다 만든 걸 빌려 쓴다.**

### 계층 C — 특정 도구를 WASM으로 컴파일 (Emscripten FS / WASI)

빌드 파이프라인에서 실제로 무거운 건 대개 소수의 네이티브 도구다 (`esbuild`, `swc`, `rollup`의 네이티브 부분 등). 이들을 **개별적으로 WASM으로** 가져오고, 그 WASM에 가상 fs를 붙이는 방식.

- **Emscripten FS**: `MEMFS`(램), `IDBFS`(IndexedDB 동기화), `WORKERFS`, `NODEFS`. WASM 모듈 하나에 대한 파일시스템.
- **WASI + preopen**: `wasmer-js`, `@bjorn3/browser_wasi_shim` 같은 런타임이 WASI 파일 디스크립터에 가상 디렉터리를 preopen으로 물려준다. esbuild-wasm이 대표적 사례.

- ✅ 가장 가볍고 목적 지향적. 필요한 도구만 wasm으로.
- ❌ **"임의의 `package.json` 프로젝트를 npm install 후 빌드"** 라는 wc-exe의 범용성과 안 맞는다. 프로젝트마다 쓰는 번들러·플러그인·postinstall 스크립트가 제각각이라, 개별 wasm 도구를 다 준비할 수 없다. npm 의존성 그래프 해석·네이티브 애드온·라이프사이클 스크립트를 감당 못 한다.

→ 범용 빌더가 아니라 "고정된 파이프라인"이면 최선. wc-exe에는 부분 최적화용.
→ 다만 이 계층을 **얼마나 멀리 밀 수 있는지**는 almostnode가 보여준다(§9): 프로젝트 자신의 `esbuild`→esbuild-wasm, `rollup`→`@rollup/browser`로 **번들러 의존성을 인터셉트해 갈아끼우는** 기법이다. vite 생태계처럼 파이프라인이 수렴된 영역이면 "고정"과 "범용" 사이까지 갈 수 있다.

### 계층 D — 전체 시스템 에뮬레이션 (질문의 QEMU 방향)

**진짜 CPU + 진짜 리눅스 커널을 브라우저에서 에뮬레이트**하고, 그 안에서 평범한 `node`/`npm`을 돌린다. 파일시스템은 게스트 리눅스의 진짜 ext4/9p이고, 브라우저는 그 디스크 이미지를 메모리(또는 OPFS)에 들고 있을 뿐이다. → **"가상 fs"를 가장 근본적으로 구현하는 방법.** 파일시스템을 흉내 내는 게 아니라 _실제 커널의 fs를 그대로 쓴다._

대표 프로젝트:

- **[v86](https://github.com/copy/v86)** — x86을 JS/wasm으로. 가볍지만 32비트, 성능 제약.
- **[qemu-wasm](https://github.com/ktock/qemu-wasm)** (ktock, NTT) — QEMU를 브라우저로 포팅, **TCG(JIT) 켜짐**. aarch64/x86_64 게스트.
- **[container2wasm](https://github.com/container2wasm/container2wasm)** — OCI 컨테이너 이미지를 wasm으로 변환. `--to-js`로 브라우저에서 **컨테이너를 그대로 실행**. 내부적으로 QEMU-wasm(또는 Bochs/TinyEMU)이 CPU를 에뮬레이트하고 그 위에서 `runc`가 컨테이너를 띄운다. 2025년 FOSDEM에서 발표된, 이 분야에서 가장 성숙한 결과물.

이게 사용자가 감을 잡은 그 방향이 맞다. "QEMU를 wasm으로 돌릴 수 있다 → 그 안에 리눅스 → 그 안에 node → 파일은 전부 게스트 안(=브라우저 메모리)에만" 이라는 논리는 정확히 성립하고, 이미 동작하는 데모까지 있다.

### "저수준으로 간다"에는 방향이 둘 있다

이 스펙트럼은 "에뮬레이션 깊이 순"으로 정렬돼 있어서 아래로 갈수록 저수준이라는 인상을 준다. 그런데 **WebContainer(B)보다 저수준으로 간다**는 말은 실제로 정반대의 두 가지를 뜻할 수 있고, 측정 결과도 정반대로 나왔다.

- **아래로 깊게 — 에뮬레이션을 더 한다 (D).** 진짜 커널, 진짜 프로세스. 가장 근본적이지만 **빌드 버스트에서 35× 느리다**(§7). CPU 에뮬레이션 세금이 wc-exe가 없애려던 I/O 병목보다 크다. 이 방향은 이미 판정이 났다.
- **옆으로 얕게 — 추상화를 걷어낸다 (C).** npm도 vite도 Node도 돌리지 않고 그 아래의 **번들러를 직접 구동**한다. 브라우저 rolldown 버스트가 네이티브 vite 5와 같은 범위다(§9). 이 방향은 이기고 있다.

즉 "StackBlitz보다 저수준으로"라는 직관이 향하는 곳은 D가 아니라 **C**다. 그리고 C의 대가는 성능이 아니라 **범용성**이다 — 프로세스가 없으니 lifecycle scripts가 영원히 안 열리고(§9), 플러그인 생태계를 우리가 떠안는다(§10). **성능을 얻으려 내려가는 게 아니라, 폐쇄 런타임 의존을 버리려고 내려가는 것**이다. 그러니 판단 기준도 속도가 아니라 "그 의존이 실제로 얼마를 청구하는가"여야 한다(§10 확정 7).

---

## 3. QEMU/container2wasm 심층 — 되는 것과 대가

### 되는 것

- **완전한 리눅스 유저스페이스.** 임의의 `npm install`, native addon 컴파일, postinstall, 심지어 다른 언어 툴체인까지. WebContainer의 제약(순수 JS Node 폴리필 환경)을 넘어선다.
- **파일시스템이 진짜다.** 게스트의 ext4가 곧 VFS. 디스크 이미지는 브라우저 안에만 있으니 **호스트 디스크에 아무것도 안 쓴다 = 백신 스캔 0** 이라는 wc-exe의 목표를 가장 순수하게 달성.
- 스냅샷/롤백이 디스크 이미지 단위로 자연스럽다.

### 대가

1. **성능.** CPU 에뮬레이션 + JIT라도 네이티브 대비 수 배~수십 배 느리다. `npm install`이 CPU 바운드가 되어 오히려 느려질 수 있다. wc-exe의 원래 병목(I/O 스캔)은 없앴지만 CPU 병목을 새로 얻는 트레이드. **실측이 반드시 필요.**
2. **크로스오리진 격리 필수.** `SharedArrayBuffer` 기반이라 `COOP: same-origin` + `COEP: require-corp`. 다행히 wc-exe는 이미 이 헤더를 붙이는 Hono 서버가 있다 (WebContainer도 같은 요구사항).
3. **부팅/이미지 크기.** 리눅스 rootfs + node 이미지를 wasm으로 실어야 함. 수십~수백 MB. 최초 부팅 지연.
4. **네트워킹.** 게스트에서 `npm`이 레지스트리를 때리려면 브라우저 Fetch/WebSocket으로 패킷을 프록시해야 한다 (container2wasm은 WebSocket 포워딩 제공). wc-exe는 이미 로컬 Hono 서버가 있으니 **여기에 npm 레지스트리 프록시를 붙이는 형태**가 자연스럽다.

---

## 4. wc-exe 관점 비교표

| 접근                        | 범용 빌드                       | 호스트 디스크 쓰기 | 무게              | 성숙도        | WebContainer 탈피                |
| --------------------------- | ------------------------------- | ------------------ | ----------------- | ------------- | -------------------------------- |
| A. memfs/ZenFS              | ❌ 실행 불가                    | 없음               | 매우 가벼움       | 높음          | 부분(캐시용)                     |
| B. WebContainer (현행)      | ✅                              | 없음               | 중간              | 높음          | —                                |
| B'. burrow (§8)             | △ 자체 런타임 의미론            | 없음               | 중간              | 초기          | 완전(단, 범용성 ↓)               |
| B''. almostnode (§9)        | △ dev·CLI 중심, **빌드 미검증** | 없음               | 가벼움(250KB+CDN) | 초기          | 완전(단, execSync·네이티브 불가) |
| B'''. vrowzer (§9)          | ❌ dev 전용, 빌드 미연결        | 없음               | 무거움(11MB wasm) | 초기          | 완전(단, vite 버전 고정)         |
| C. wasm 도구 + WASI fs      | △ 고정 파이프라인만             | 없음               | 가벼움            | 중간          | 부분                             |
| D. QEMU-wasm/container2wasm | ✅✅ (진짜 리눅스)              | 없음               | 무거움            | 실험적·발전중 | 완전                             |

---

## 5. 현실적인 로드맵 제안

축을 나눠서 접근하는 걸 권한다. **"WebContainer를 당장 갈아엎기"가 아니라 "VFS 축을 우리가 통제하기"** 부터.

**단기 — 현행 유지 + 영속 캐시 계층 도입 (계층 A 활용)** ✅ **구현됨**
지금 가장 큰 불편은 매 실행마다 `npm install`을 처음부터 하는 것. `node_modules`를 **OPFS에 스냅샷**해두고 재사용한다. `--cache` 플래그(`build`/`install`)로 켠다.

- 동작: lockfile(`package-lock.json`→…→`package.json`) 해시를 키로, WebContainer의 `export('node_modules','binary')` 스냅샷을 OPFS에 저장. 다음 실행에서 키가 같으면 `mount(snapshot,{mountPoint:'node_modules'})`로 복원하고 **`npm install`을 통째로 건너뛴다.**
- **실측(sample-vite-app, macOS)**: cold(캐시 없음) install 11.7s → **warm(캐시 히트) install 0.3s** (install 전체 스킵). lockfile 변경 시 키가 바뀌어 자동 무효화(재설치·재캐시) 확인.
- ⚠️ **HIT 경로에 잠복 버그가 있었고 실측 중 발견·수정했다**: `mount(snapshot,{mountPoint})`는 **마운트 지점이 미리 존재해야** 한다. 없으면 런타임이 `[FS] invalid mount point`를 **로그만 찍고 resolve**해버려서, `restoreNodeModules`가 빈 디렉터리를 두고 `true`(=HIT)를 반환했다. 결과적으로 install은 건너뛰지만 `node_modules`가 비어 `npm run build`가 `vite: command not found`(exit 127)로 죽는다. 수정: 마운트 전에 `mkdir(recursive)`, 그리고 **복원 후 `readdir`로 실제 내용물을 검증**해 실패를 HIT이 아닌 MISS로 강등. (`Runtime` 인터페이스에 `mkdir` 추가)
- 제약(정직하게): OPFS는 **origin 스코프**라 러너 포트를 고정(`5199`)해야 하고, 브라우저 프로파일이 유지돼야 해 **puppeteer userDataDir를 영속 디렉터리**(`~/.cache/wc-exe/chrome-profile`)로 둔다. 즉 "호스트 디스크에 아무것도 안 쓴다"가 완벽히 지켜지는 건 아니고, **프로젝트 dir엔 여전히 아무것도 안 쓰되** node_modules는 크롬 프로파일 안 불투명 blob(대용량 순차 쓰기, 수만 개 소파일 아님)으로만 남는다. 백신 I/O 관점에선 여전히 큰 이득.
- **WebContainer는 그대로 두고 그 아래 저장 계층만 우리가 소유** — 이 문서의 핵심 전략을 최소 비용으로 실현.
- 참조: burrow의 `src/vfs`(IndexedDB debounced 스냅샷, `snapshot.ts`/`persistence.ts`)가 같은 "추출된 트리를 통째 영속화" 발상. 단 burrow는 **타르볼 캐시가 없다**(§8, 아래 단기+에서 정정).

**단기+ — 타르볼 레벨 캐시로 부분 무효화 (계층 A 심화)** ✅ **구현됨**
위 스냅샷 캐시는 **all-or-nothing**이다: lockfile이 한 글자만 바뀌어도 키가 달라져 MISS → 전체 재설치. 큰 프로젝트에서 의존성 하나 bump할 때마다 install 전체를 다시 내려받는 게 아깝다. 그래서 **npm 자신의 content-addressed 캐시(cacache)를 OPFS에 스냅샷**해, MISS에서도 **바뀐 패키지만 네트워크로** 가져오게 했다.

- 동작(runner `installWithCache`, MISS 경로): 전역 OPFS blob `npm-cacache.bin`을 `.npm-cache`로 복원 → `npm install --prefer-offline --cache .npm-cache` (변경 없는 타르볼은 cacache에서 재생, 새/변경분만 다운로드) → node_modules 스냅샷(lockfile 키)과 **갱신된 cacache blob(전역, 키 없음)**을 함께 저장.
- 경로는 **프로젝트 루트 상대**여야 한다. 런타임 파일시스템 **루트(`/`)는 쓰기 불가**라 절대경로 `/.npm-cache`를 쓰면 npm이 `EACCES: mkdir /.npm-cache/_cacache/tmp`로 죽는다(실측 중 발견). 마운트 지점도 프로젝트 루트 기준으로 해석되므로 상대 경로 하나로 mount·`--cache`·export를 모두 맞춘다.
- **캐시 축이 둘로 갈린다**: node_modules 스냅샷은 lockfile별(정확한 결과 복원용), 타르볼 cacache는 **전역 누적**(lockfile 버전 간 공유). 이 분리가 "부분 무효화"의 핵심 — lockfile이 바뀌어도 타르볼 캐시는 살아남는다.
- burrow 대비: burrow는 락파일을 synthetic packument로 바꿔 **메타데이터(packument) fetch만** 스킵하고 타르볼은 매번 재다운로드한다(에이전트 확인). wc-exe는 npm의 cacache가 이미 **integrity 해시로 키잉된 타르볼+메타 캐시**라, 그걸 스냅샷하는 것만으로 burrow가 못 채운 갭(타르볼 재사용)까지 공짜로 얻는다. "진짜 npm 유지" 제약이 오히려 유리하게 작용한 케이스.

### 실측 결과 (2026-07, macOS, sample-vite-app, `bench/cache-scenarios.mjs`)

대조 실험으로 잰다. C와 D는 **완전히 같은 작업**(의존성 하나 추가된 프로젝트를 설치)이고 차이는 타르볼 캐시 유무뿐이다.

| 시나리오                              | install   | 상태                        |
| ------------------------------------- | --------- | --------------------------- |
| A cold-base (캐시 없음)               | 11.66s    | snapshot MISS, cacache 시딩 |
| B warm-base (lockfile 동일)           | **0.30s** | snapshot HIT (install 스킵) |
| C warm-changed (dep 하나 추가)        | **5.74s** | snapshot MISS + tarball HIT |
| D cold-changed (동일 작업, 캐시 없음) | 11.35s    | snapshot MISS               |

**결론: 타르볼 캐시가 실제로 동작한다 — C vs D에서 11.35s → 5.74s (1.98×, 5.6s 절약).** lockfile이 바뀌어 스냅샷이 무효화돼도 install 비용이 절반으로 줄었다.

- 저장 비용 — cacache blob이 이 작은 vite 앱 하나에 **69MB**로 node_modules 스냅샷(21MB)의 **3.3배**다. 게다가 `nm-<key>.bin`은 **lockfile마다 하나씩 새로 생겨** 곱으로 늘어난다. → 아래 축출로 상한을 걸었다.
- 정직한 한계 2 — 2× 는 좋지만 **B의 0.3s에는 한참 못 미친다**. 타르볼 캐시는 네트워크만 없애고 npm의 해석·node_modules 재구성은 그대로 하기 때문. lockfile이 거의 안 바뀌는 프로젝트라면 이득이 드물게만 발생한다. → 이 간극을 더 좁히려면 npm이 하는 일 중 **해석·재구성까지** 우리가 가져와야 한다. 그 방향의 설계와 비용은 **§9(하이브리드)** 에 정리했다.
- `--prefer-offline`이라 캐시에 없으면 조용히 네트워크로 degrade(견고).
- 재현: `node bench/cache-scenarios.mjs` (격리된 임시 캐시 디렉터리·프로파일 사용, 실제 `~/.cache/wc-exe`는 건드리지 않음).

### 캐시 축출 (용량 상한) ✅ **구현됨**

두 캐시 모두 무한 증가하므로 성격에 맞게 다르게 상한을 건다.

- **`nm-*.bin` 스냅샷 → LRU 바이트 예산** (`MAX_SNAPSHOT_BYTES`, 기본 512MB). lockfile마다 새 blob이 생겨 곱으로 늘어나는 쪽이라 제대로 된 LRU가 필요하다. OPFS엔 쓸만한 access time이 없어 `cache-index.json`에 `lastUsed`를 직접 기록하고, 오래된 것부터 예산 이하가 될 때까지 삭제한다. **이번 실행이 쓴 항목은 축출에서 보호**된다.
- **cacache blob → 하드 캡 후 드롭** (`MAX_CACACHE_BYTES`, 기본 256MB). 단일 blob이라 LRU 개념이 없고, 전부 **재생성 가능**하므로 상한을 넘으면 그냥 지운다. 대가는 다음 install 한 번이 온라인이 되는 것뿐.
- 인덱스는 실제 OPFS 목록을 기준으로 정리해 파일이 사라져도 드리프트하지 않는다.
- **검증**: 상한을 임시로 25MB/50MB로 낮춰 lockfile 3종을 연속 실행 → cacache는 매번 `69 MB over 50 MB cap — dropped` 후 재시딩(`tarballHit=false`), 스냅샷은 매번 직전 것이 `evicted LRU snapshot ...(20.2 MB)`로 축출되고 최신 것만 남아 OPFS가 예산을 넘지 않음을 확인. 운영값 복귀 후 벤치 재실행에서 회귀 없음(C vs D 2.32×).

#### TODO — 상한을 CLI 플래그로 노출

지금 두 상한은 러너 번들 안의 **하드코딩 상수**라 사용자가 못 바꾼다. 실제로 이번 축출 검증조차 소스를 임시로 고쳐 빌드해야 했는데, 그게 곧 이 API의 부재를 보여준다.

- **무엇을**: `build`/`install`에 `--cache-max-snapshots <size>`, `--cache-max-tarballs <size>` 추가 (`512MB`/`2GB` 같은 사람이 읽는 크기 문자열 파싱). 기본값은 현재 상수와 동일하게.
- **왜**: 프로젝트 규모별로 적정 상한이 크게 다르다. 모노레포는 스냅샷 하나가 수백 MB라 512MB로는 한 개도 못 담고, 반대로 디스크가 빠듯하면 더 낮춰야 한다. 지금은 어느 쪽도 대응이 불가능하다.
- **어디를**: `src/cli.ts`(옵션 정의, 기존 `--cache` 옆) → `src/types.ts`(`BuildOptions`/`InstallOptions`) → `src/commands/*.ts` → `WCBrowser.installWithCache()` 인자 → 러너 `installWithCache`가 상수 대신 인자를 사용. 러너는 페이지 안이라 env를 못 읽으므로 **호스트가 값을 넘겨주는 경로**가 필요하다.
- **덤**: 인자로 주입 가능해지면 축출 검증을 소스 수정 없이 할 수 있어, `bench/cache-scenarios.mjs`에 축출 시나리오를 정식 추가할 수 있다.
- **주의**: 상한을 0이나 아주 작게 주면 방금 쓴 항목만 남고 매번 전부 축출된다(현재 구현은 이번 실행 항목을 보호하므로 동작은 안전하되 캐시가 무의미해짐). 하한 검증이나 경고가 필요할지 판단할 것.

**중기 — 자체 VFS 추상화로 결합도 낮추기** ✅ **구현됨**
`src/runner`가 WebContainer API에 직접 묶여 있던 것을 백엔드 중립 인터페이스 뒤로 격리했다:

- `src/runner/src/runtime/runtime.types.ts` — `Runtime` 인터페이스(`boot`/`mount`/`spawn`/`readFile`/`writeFile`/`readdir`/`onServerReady`) + 선택적 `SnapshotProvider`(`exportDir`/`importSnapshot`)와 `isSnapshotCapable` 타입가드. 스냅샷은 WebContainer 고유(binary export)라 **필수가 아닌 능력**으로 분리 — 스냅샷 없는 백엔드는 캐시가 자동으로 평범한 install로 degrade.
- `src/runner/src/runtime/webcontainer-runtime.ts` — `@webcontainer/api`를 참조하는 **유일한** 모듈(`WebContainerRuntime implements Runtime, SnapshotProvider`).
- `main.ts` 오케스트레이션은 인터페이스만 바라봄. 백엔드 추가 = 이 인터페이스 구현 하나.

burrow의 `src/contract`(타입드 서비스 레지스트리)가 같은 발상의 큰 규모 예시지만, 러너 규모엔 단일 인터페이스 파일이 맞는 고도다.

**장기 — container2wasm PoC로 WebContainer 독립성 검증**
독점 의존과 Node 환경 제약이 실제로 발목을 잡는 시점이 오면, container2wasm `--to-js`로 "node 이미지 + 샘플 vite 앱 빌드"를 브라우저에서 돌려 **실측**(부팅 시간, install 시간, build 시간)한다. 네트워킹은 기존 Hono 서버에 npm 레지스트리 WebSocket 프록시를 붙여 해결. 성능이 감당되면 진짜 리눅스라 범용성/네이티브 애드온 문제가 근본적으로 풀린다.

### 핵심 판단

- 사용자의 직관(QEMU-wasm) 은 **기술적으로 옳고 이미 구현체가 있다** (container2wasm). "가상 fs"를 가장 근본적으로 푸는 길이다.
- 다만 wc-exe의 원래 목적은 *I/O 병목 제거*였는데, 전체 에뮬레이션은 *CPU 병목*을 새로 들여온다. 그래서 "무조건 QEMU"가 아니라, **저장 계층(VFS)은 지금부터 우리가 소유하고(OPFS 캐시), 실행 계층은 WebContainer를 유지하되 인터페이스로 격리해 두었다가, container2wasm이 성능적으로 익으면 갈아끼우는** 단계적 경로가 가장 합리적이다.

---

## 6. WebContainer는 오픈소스인가? — "얇은 레이어만 떼오기"는 불가능

"WebContainer에서 재사용 가능한 얇은 fs 레이어만 가져오면 좋겠다"는 발상은 자연스럽지만, 공개 범위를 확인하면 **공개된 부분과 가치 있는 부분이 정확히 반대로 나뉜다.**

StackBlitz 조직의 `webcontainer-*` 리포를 실제로 까보면:

| 리포                                                             | 정체                                                                                                                                          | 소스            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `stackblitz/webcontainer-core` (⭐4.6k, MIT)                     | 이름은 core지만 **이슈 트래커**. README에 "central hub for GitHub issues and bug reports"라고 명시. 루트에 `README.md`·`repro.md`·`LICENSE`뿐 | ❌              |
| `webcontainer-docs` / `webcontainer-api-starter` / `tutorialkit` | 문서·예제·튜토리얼                                                                                                                            | ❌              |
| `@webcontainer/api` (npm, 현재 의존)                             | 실제 런타임에 붙는 **클라이언트 스텁(RPC 글루)**                                                                                              | 배포만, 소스 ❌ |

레이어링이 우리가 원하는 것과 뒤집혀 있다:

```
[@webcontainer/api]        ← 공개. 하지만 원격 호출 스텁 (알맹이 없음)
─────────────────────────  ← 폐쇄 경계
[VFS + Node 에뮬 + wasm]   ← 부팅 시 StackBlitz 인프라에서 내려받음. 완전 폐쇄
```

즉 **공개된 얇은 층은 껍데기고, 탐내는 fs/런타임 알맹이가 정확히 닫힌 부분**이다. 라이선스도 StackBlitz Terms of Service(OSS 무료, 기업 상용 라이선스)라 리버스 엔지니어링도 걸린다. → WebContainer에서 얇게 떼오기는 성립하지 않는다.

**대신 "얇은 레이어" 직관은 대상만 바꾸면 옳다:**

- **VFS 층만** 원한다 → [ZenFS](https://github.com/zen-fs/core) / [memfs](https://github.com/streamich/memfs) (둘 다 MIT, `fs` 호환, 진짜 얇음). OPFS 캐시(§5 단기)를 이걸로 바로 구현.
- **실행 층까지** 원한다 → 오픈으로 같은 걸 얻으려면 [container2wasm](https://github.com/container2wasm/container2wasm)뿐이고, "얇지" 않다.

핵심: **실행 엔진을 "얇게, 오픈으로" 떼올 방법은 존재하지 않는다.** 그래서 WebContainer가 닫아 사업화했고 container2wasm은 커널째 에뮬레이트하느라 무겁다. 얇게 떼올 수 있는 건 VFS 저장 층(ZenFS/memfs)까지고, 그 위 실행은 "WebContainer(닫힘·가벼움) vs container2wasm(열림·무거움)"의 양자택일이다.

---

## 7. 성능은 실제로 문제인가 — 레퍼런스와 실측 계획

container2wasm의 성숙도/plumbing 리스크는 이미 실전 레퍼런스로 상당히 내려갔다:

- **[vscode-container-wasm](https://github.com/ktock/vscode-container-wasm)** — container2wasm으로 변환한 컨테이너를 **VS Code for the Web 안에서** 실행하는 확장. Microsoft `vscode-wasm` + `browser_wasi_shim`을 패치해 쓰며, SharedArrayBuffer(`?vscode-coi=on`)·워크스페이스 마운트(`/workspace`)·Fetch 기반 네트워킹이 **동작**한다. 즉 부팅·fs·네트워킹 plumbing은 오픈 스택으로 재현 가능함이 입증됨.

다만 "그러니 성능도 문제없다"는 아직 **절반만 맞다** — workload가 정반대이기 때문:

|             | vscode-container-wasm    | wc-exe                            |
| ----------- | ------------------------ | --------------------------------- |
| 주 작업     | 편집 + 가끔 터미널       | **`npm install` + 프로덕션 빌드** |
| CPU 특성    | 대부분 idle, 짧은 버스트 | **길고 무거운 CPU 버스트**        |
| 느림의 체감 | "느려도 편집은 쾌적"     | 그대로 총 빌드 시간               |

에뮬레이션 오버헤드(네이티브 대비 수 배~수십 배)는 CPU 바운드에서만 정직하게 드러나는데, wc-exe의 존재 이유가 바로 그 CPU 바운드 버스트다. 레퍼런스들도 "부팅에 시간이 걸린다"고만 하고 **install/build 벤치마크는 없다.** 결국 반증도 입증도 안 된 유일한 변수는 **wc-exe 실제 workload의 CPU 시간** 하나다.

### 네트워킹 — 남의 약점이 우리한텐 이점

vscode-container-wasm은 브라우저 네트워킹을 "CORS 제한 + Forbidden header 제어 불가"로 단점 표기한다. 이는 github.dev 같은 순수 브라우저 배포의 한계다. wc-exe는 **이미 로컬 Hono 서버가 있어** npm 레지스트리를 그 서버로 프록시하면 CORS/헤더 문제를 우회할 수 있다.

### 실측 계획 (go/no-go)

말싸움 대신 숫자 하나로 결판낸다. `test/fixtures/sample-vite-app`을 대상으로 `npm install && npm run build`의 **벽시계 시간**을 두 방식으로 잰다:

1. **WebContainer 기준선** — 현행 인프라 재사용 (`bench/webcontainer.mjs`)
2. **container2wasm** — Node 컨테이너를 `c2w`로 변환 → COI 헤더로 서빙 → headless로 workload 실행·측정 (`bench/container2wasm/`)

> 측정은 **보안 소프트웨어가 있는 실제 사용자 머신**에서 의미가 있다(이 프로젝트의 존재 이유가 그 환경이므로). 하네스는 리포에 재현 가능하게 두고 로컬에서 돌린다. `bench/README.md` 참조.

판정:

- 감당 가능 → container2wasm으로 WebContainer 독립 진행 (§5 장기를 앞당김)
- 너무 느림 → WebContainer 유지 + OPFS 캐시(§5 단기)로 실익 확보

### 실측 결과 (2026-07, macOS M-series / 16GB, sample-vite-app)

| 엔진                                         | `npm run build` | 비고                                                    |
| -------------------------------------------- | --------------- | ------------------------------------------------------- |
| WebContainer                                 | **~1.6s**       | install ~11.1s, boot ~5.4s(1회성)                       |
| container2wasm (wasmtime / Bochs)            | **~56s**        | host wallclock: 실행 ~61s − 부팅 ~5.3s. **약 35× 느림** |
| container2wasm (browser `--to-js`, QEMU-JIT) | 미측정          | 위 Bochs보다는 빠를 것                                  |

측정 과정에서 얻은 실전 교훈(하네스 `bench/container2wasm/run.sh`에 반영):

- **macOS엔 c2w 네이티브 바이너리가 없다** → linux c2w를 Docker 소켓 연결한 컨테이너 안에서 실행.
- c2w 내장 Dockerfile이 **낡은 repo에서 assets를 git clone**(`ktock/...`의 v0.8.4 태그 404) → 로컬 clone 후 `--assets`로 우회.
- **게스트 클럭 스큐**: 에뮬 게스트의 `date`·vite "built in 11.55s"는 실시간과 불일치 → host wallclock으로 측정, 부팅분 차감.
- **stdin EOF**: stdin이 닫히면 게스트가 부팅 중 EOF 읽고 exit 1 → c2w `-no-stdin` + `</dev/null`.

**판정: WebContainer 유지.** Bochs/WASI는 보수적 상한이지만 1.6s→56s(35×)라, 브라우저 QEMU-JIT가 수 배 빨라도 동률까지 좁히긴 어렵다. 빌드 버스트 성능만 놓고 보면 WebContainer가 앞선다. 대신 **§5 단기 OPFS 캐시**로 재발 비용인 install(~11s)을 줄이는 게 확실한 실익. container2wasm은 "성능"이 아니라 "WebContainer 독립성" 또는 "네이티브/비-JS 툴체인"이 동인이 될 때만, 그것도 `--to-js` 브라우저 경로를 먼저 재고 재검토한다.

---

## 8. 참고 사례: burrow — "에뮬레이트하지 말고 주변만 가상화하라"

[dhravya/burrow](https://github.com/dhravya/burrow) (MIT) — "브라우저 탭 안의 완전한 dev 머신". 진짜 Bun 트랜스파일러·git·셸·라이브 프리뷰·로컬 AI 에이전트를 전부 페이지 안에서 돌리는, **자칭 오픈소스 WebContainer 대안**이다.

### 핵심 설계 결정

Bun은 JavaScriptCore 위의 Zig라 wasm으로 통째 컴파일이 불가능하다. burrow의 답:

> **CPU를 에뮬레이트하지 말고, 브라우저 자체 JS 엔진 위에서 JS를 돌리고 그 주변만 가상화한다.**

- `bun.wasm` — Bun의 Rust 트랜스파일러만 wasm+WASI 심으로 (진짜 TS/JSX 의미론)
- `src/vfs` — 인메모리 POSIX 트리, 에디터·셸·git·런타임이 공유, **debounced 스냅샷 → IndexedDB 영속**
- `src/npm` — **from-scratch 브라우저 패키지 매니저**: 의존성 해석 → npm 타르볼 다운로드 → 자체 tarball 리더 → flat-hoisted `node_modules` 생성. `burrow-lock.json`으로 **오프라인 재생** 가능
- Web Worker = 프로세스, 서비스워커 = 네트워킹 (`Bun.serve()`를 실제 fetch 가능 URL로, per-port 라우팅)
- `src/contract` — 9개 모듈이 서로 직접 import하지 않고 **타입드 서비스 레지스트리**로만 통신

이는 §2 스펙트럼에서 **B와 C 사이의 새 지점(B')**이다: container2wasm(D)의 CPU 병목을 아예 회피하면서(에뮬을 안 하니까) 오픈소스를 달성했다. 대가는 **범용성** — 진짜 Node/vite가 아니라 독자 런타임 의미론이고, README 스스로 "far less complete, TCP·native addon·일부 Bun API 갭"을 인정한다.

### wc-exe 관점 판정

- **엔진 통째 교체 후보 ❌** — wc-exe의 임무는 "임의 프로젝트를 `npm install && vite build`"인데, burrow는 vite build(esbuild/rollup 스폰, 플러그인, config 해석)를 그대로 못 돌린다.
- **부품 광산 ✅✅** — 가치 순:
  1. **`src/npm`** ⭐ — install 자체를 브라우저에서 재현 + 락파일 오프라인 재생. §5 단기(캐시)의 한 발 앞 형태. WebContainer의 npm install을 이 방식으로 대체/보완하면 CPU 에뮬 없이 install을 고속화할 수 있다.
  2. **`src/vfs`** — §5 단기 "IndexedDB 스냅샷"의 동작하는 MIT 참조 구현. 디바운스 전략·락파일 연동을 그대로 참고.
  3. **`src/contract`** — §5 중기 "인터페이스로 결합도 낮추기"의 실물 예시. 백엔드 교체(WebContainer ↔ container2wasm)를 위한 경계 설계 모델.
  4. 서비스워커 네트워킹 — wc-exe는 진짜 로컬 Hono 서버가 있어 불필요. dev 프리뷰 프록시 설계 시 참고만.

### 전략적 의미

burrow의 존재는 "오픈 + 빠름"이 container2wasm(오픈 + 느림) 말고도 가능함을 보여주지만, 그 대가가 범용성임을 동시에 확인해준다. §7 실측(에뮬 35×)으로 container2wasm이 성능에서 탈락한 지금, burrow는 **"오픈으로 가는 유일한 현실적 경로가 B'식(에뮬 없는 주변 가상화)임"**을 보여주는 사례이기도 하다 — 다만 wc-exe가 그 길을 가려면 진짜 vite 의미론을 포기해야 하므로 여전히 엔진 후보는 아니다.

wc-exe의 확정 결론: **실행 엔진은 WebContainer 유지(§7 판정), install/캐시 계층만 burrow식으로 흡수.** OPFS 캐시(§5 단기, 구현됨)를 고도화할 때 — 부분 무효화, 레지스트리 타르볼 레벨 캐시, 오프라인 락파일 재생 — burrow `src/npm`이 첫 참조다.

---

---

## 9. `node:fs` 가상화로 npm을 대체할 수 있나 — 그리고 하이브리드 착지점

> 질문: 가상 fs(memfs/ZenFS)만 충분히 갖추면, 나중엔 **npm 자체도** 브라우저에서 돌릴 수 있지 않을까?

답: **`node:fs`는 필요조건이지 충분조건이 아니다.** 그리고 부족한 그 부분이 정확히 §1에서 나눈 "저장소(VFS) vs 실행 엔진" 경계다.

### npm install을 단계로 분해하면

| 단계                               | 필요한 node 기능          | 브라우저에서                                                 |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------ |
| 1. resolve (레지스트리 메타데이터) | `http(s)`                 | ✅ fetch로 shim (npm 레지스트리는 CORS 허용 — burrow가 증명) |
| 2. 타르볼 다운로드                 | `http(s)`                 | ✅ 동일                                                      |
| 3. 압축 해제                       | `zlib` + `fs`             | ✅ `DecompressionStream` + 가상 fs                           |
| 4. hoist/링크, bin `chmod +x`      | `fs` (symlink, mode)      | ✅ **여기까지가 fs로 되는 범위**                             |
| 5. **lifecycle scripts**           | **`child_process.spawn`** | ❌ **벽**                                                    |
| 6. native addon 빌드 (node-gyp)    | 컴파일러 툴체인           | ❌ 더 큰 벽                                                  |

1~4는 실제로 가능하고, burrow가 정확히 그 범위를 자체 구현해 증명했다(§8). 벽은 5부터다.

### 왜 5가 벽인가

`child_process.spawn`은 **파일시스템 문제가 아니라 프로세스 모델 문제**다. 브라우저엔 프로세스가 없다.

- 스폰 대상이 **JS(node 스크립트)** → Web Worker로 근사 가능
- 스폰 대상이 **네이티브 바이너리**(esbuild, node-gyp가 부르는 `cc`) → 불가능

`node:fs`를 아무리 완벽하게 가상화해도 이 층은 열리지 않는다. §1의 두 축 구분이 여기서 다시 확인된다.

### 이미 답이 두 갈래로 나와 있다

- **WebContainer** = "진짜 npm을 돌린다" 쪽. 그러려면 fs만이 아니라 **node 런타임 전체**(process, child_process, net, worker…)를 shim해야 했고, 그게 어려우니 폐쇄·상용화됐다(§6). → **이 질문의 완성형을 우리가 이미 쓰고 있는 셈.**
- **burrow** = "진짜 npm을 포기한다" 쪽. 자체 PM으로 1~4만 커버하고 lifecycle scripts는 사실상 포기. 훨씬 쉬운 길.

즉 **npm을 *그대로* 돌리려면 fs 가상화가 아니라 node 재구현이 필요**하고, **fs 가상화만으로 도달 가능한 최대치가 burrow식 자체 PM**이다.

참고로 "패키지 매니저를 fs 추상화 위에 짓는다"는 발상 자체는 검증돼 있다 — Yarn Berry가 [`@yarnpkg/fslib`](https://github.com/yarnpkg/berry)(ZipFS 등)로 fs를 의도적으로 추상화해 패키지를 zip 안에 둔다. 단 Yarn도 스크립트 실행엔 여전히 `child_process`가 필요하다.

### 실증 사례: almostnode — 1~4는 되고 5에서 정확히 막힌다

[macaly/almostnode](https://github.com/macaly/almostnode) (MIT) — "Node.js in your browser". 위 분해에 대한 **가장 진전된 실증**이다. 소스를 직접 확인한 결과:

**해낸 것 (1~4단계)**

- **진짜 npm install** — `registry.npmjs.org`에 브라우저에서 직접 fetch(CORS 허용), 타르볼을 VFS에 풀고, `package.json`의 `bin`을 읽어 `/node_modules/.bin/`에 stub을 만들고 PATH에 추가(`src/npm/registry.ts`, `resolver.ts`, `tarball.ts`). burrow(자체 resolver)보다 한 발 더 나갔다 — 실제 레지스트리 + bin 링킹까지.
- **40+ node 모듈 shim** + 동기/비동기 VFS(`readFileSync` 등), 967개 호환성 테스트.
- **번들러 의존성 인터셉트** — `src/shims/esbuild.ts`(→ esbuild-wasm), `src/shims/rollup.ts`(→ `@rollup/browser`, CDN). 프로젝트가 `require('esbuild')`해도 네이티브 바이너리가 아니라 wasm 구현이 물린다. ← 계층 C(§2) 기법의 실제 구현체.
- **`child_process`는 `just-bash`(wasm 셸)로** — `spawn`이 비동기로 동작하고, vitest·eslint·tsc 같은 bin CLI가 실제로 돈다.
- Vite/Next **dev server** 내장, Service Worker가 `/__virtual__/<port>/`를 라우팅. ~250KB gzip, 부팅 "instant"(WebContainer 2~5s 대비).

**§9의 벽이 문자 그대로 확인된다 (5~6단계)**

- **`execSync`/`spawnSync`가 throw한다** — `"execSync is not supported in browser environment"`(`src/shims/child_process.ts`). **동기 프로세스 스폰은 shim으로 넘을 수 없다**는 5번 벽의 가장 선명한 증거다. 빌드 스크립트가 `execSync`를 쓰면 그 자리에서 끝난다.
- IPC 미지원, 네이티브 모듈은 stub only, 실제 TCP/IP 없음(`net`/`tls`/`dns`/`dgram` stub, 가상 포트만).
- **`npm install`의 install 훅(`preinstall`/`postinstall`)은 돌리지 않는다.** 지원하는 pre/post는 `npm run` 계열(prestart/start/poststart, pretest/…)뿐이다.

**wc-exe 관점: 엔진 대체 후보는 아니다**

- **almostnode README 스스로가** "When to use WebContainers" 절에 **"Complex build pipelines"** 와 "Production-like environments"를 적어 두었다. wc-exe의 임무가 정확히 그것이다.
- **프로덕션 빌드가 검증되지 않았다** — e2e/유닛 테스트가 전부 dev server·CLI 도구·데모이고 `vite build` 시나리오가 없다. README의 `npm run build` 예시조차 `build: 'echo Building...'`이다. rollup shim이 있어 **원리상 가능할 수는 있어도 행사된 적 없는 경로**다. 우리가 파는 곳이 하필 그 경로(`npm run build` → `dist/`)다.
- CDN 의존이 있다(esm.sh·unpkg에서 esbuild-wasm·@rollup/browser·react). WebContainer의 StackBlitz 인프라 의존(§1)을 단점으로 셌다면 이쪽도 같은 성격이다 — 다만 공개 CDN이라 자체 호스팅으로 바꿀 여지는 있다.

**그래도 값진 것 둘**

1. **§9의 분해가 실증됐다.** 추측이 아니라 동작하는 코드로 "1~4는 shim으로 되고 5에서 막힌다"가 확인된다.
2. **번들러 인터셉트 기법**이 "브라우저에서 진짜 빌드"의 구체적 경로다. 훗날 WebContainer 독립이 목표가 되면 container2wasm(§7, 35× 느림)보다 **이 길이 현실적일 수 있다** — 대가는 `execSync`·네이티브 애드온·install 훅 포기.

### PoC: 번들러 인터셉트로 프로덕션 빌드 (✅ 동작 확인, `poc/vite-build-intercept/`)

almostnode가 dev server까지만 보여주고 **행사하지 않은** 그 경로(프로덕션 빌드)를 직접 만들어 돌려봤다. `rollup`→`@rollup/browser`, `esbuild`→`esbuild-wasm`(TS 변환 **및** minify 둘 다), `node:fs`→인메모리 VFS.

**결과: 브라우저에서 동작하는 프로덕션 `dist/`가 나온다.**

- 산출물을 다시 브라우저에 띄워 **런타임 검증까지 통과** — 앱이 렌더되고, 추출된 스타일시트가 적용되고, 카운터 클릭이 증가한다(= 변환된 TS가 실제로 동작).
- **minify된 CSS가 진짜 `vite build` 출력과 바이트 단위로 동일**(673 B). JS 차이(413 B vs 1101 B)는 거의 전부 vite가 주입하는 modulepreload 폴리필이다. 이 픽스처에서 충실도는 높다.
- **COOP/COEP 불필요** — esbuild-wasm 비동기 API와 `@rollup/browser`는 `SharedArrayBuffer`를 안 쓴다. WebContainer·container2wasm 양쪽이 요구하는 제약이 사라진다.
- **CDN 불필요** — 번들러를 로컬 `node_modules`에서 서빙했다(almostnode의 esm.sh/unpkg 의존을 피함). 번들러를 wc-exe가 들고 다니므로 프로젝트별 `npm install`도 필요 없다.
- 타이밍(이 Linux 샌드박스, rollup 경로): 번들+minify 버스트 ~0.37–0.51s, 총 ~0.81–0.93s. ⚠️ `bench/README.md`의 수치는 macOS에서 잰 것이라 **직접 비교 금지**(WebContainer는 이 샌드박스에서 부팅 불가).

#### vite 8 = rolldown 경로도 구현·검증 (`--bundler=rolldown`)

**vite 8의 의존성은 `rolldown`·`lightningcss`·`postcss` — rollup도 esbuild도 없다.** 즉 지금 vite를 인터셉트한다는 건 rolldown을 인터셉트한다는 뜻이다. `@rolldown/browser`(1.2.1)가 실제로 존재하고, `lightningcss-wasm`도 있다 — vite 8 툴체인 전체에 브라우저 빌드가 있다.

- **결과: 이쪽도 static·runtime 검증 통과.** rolldown은 TS 변환과 minify를 자체(oxc)로 하므로 **esbuild-wasm이 아예 불필요**하다.
- **번들 버스트 144–153ms vs rollup 366–511ms → 약 2.4~3.5× 빠름.** 초기화가 더 무거운데도(10MB wasm, ~0.5s) 총 시간도 앞선다(0.75s vs 0.81–0.93s). 참고로 같은 머신 네이티브 `vite build`(v5)가 157ms 자체 보고 → **브라우저 rolldown 버스트가 네이티브 vite 5와 같은 범위**다.
- **대가는 배선 비용이다.** `@rollup/browser`는 페이지에서 그냥 `import`되지만 rolldown은 전부 실패를 거쳐야 했다: ① 브라우저 엔트리가 `node:fs`·`node:url`을 정적 import하고 wasi 바인딩이 `@napi-rs/wasm-runtime`을 bare로 끌어와 **사전 번들링 필수** ② wasi **워커도 별도 사전 번들링**(워커는 페이지 import map을 물려받지 않음) + 파일명 유지 ③ `process` 전역 필요 ④ **COOP/COEP 필수**(워커에 SharedArrayBuffer 전송) — rollup 경로의 이점이 사라진다 ⑤ **CSS 입력을 아예 거부**("Bundling CSS is no longer supported")해 가상 모듈로 우회해야 하고 그 id가 `.css`로 끝나서도 안 된다 ⑥ **모듈 로딩이 `generate()`로 지연**돼, 그 전에 수집한 CSS를 읽으면 오류 없이 **조용히 빈 결과**가 나온다 ⑦ 10MB wasm + 1.5MB JS + 1.2MB 워커.
- rolldown 경로는 CSS를 minify하지 않는다(거기엔 esbuild를 안 띄움). vite 8과 맞추려면 `lightningcss-wasm`을 붙이면 된다.

**증명하지 못한 것 (중요)**

- **이건 `vite build`가 도는 게 아니다.** vanilla `index.html` 앱에 대해 vite가 하는 일(엔트리 발견, TS 변환, CSS 추출, 해시 애셋, HTML 재작성)을 재구현한 것이다. vite의 config 해석·플러그인 생태계·프레임워크 플러그인·multi-page·legacy 타겟은 전부 없다.
- ~~의존성이 검증되지 않았다~~ → **React·동적 import 청킹 모두 시험 완료(아래).** 남은 미검증: `browser` 필드 remap, 깊은 `exports` 와일드카드, worker/wasm import, CSS `@import`/`url()` 애셋 참조.
- **`npm install`을 하지 않는다 — 이게 가장 큰 구멍이다.** `run.mjs`는 프로젝트 디렉터리의 `node_modules`를 **읽을** 뿐이고, PoC 어디에도 설치 단계가 없다. README의 React 사용법부터가 "먼저 `npm install` 하세요"다. 즉 **인터셉트는 현재 상태로 wc-exe의 존재 이유를 지키지 못한다** — 보안 SW가 스캔하는 그 수만 개 파일이 이미 디스크에 있어야 돌아가니까. 아래 《install 없는 인터셉트》 참조.

**왜 vite를 포팅하지 않는가 (실측)**: vite 5.4의 `dist/node`는 node 빌트인 **24개**(`child_process`·`worker_threads`·`net`·`tls`·`dns`·`inspector`·`module` 포함)를 import하고, 최소 한 청크가 `execSync`/`spawnSync`를 쓴다 — almostnode가 막히는 바로 그 벽이다. 인터셉트 방식은 vite를 **실행하는 대신 대체**하므로 그 24개가 전부 불필요하다. **vite를 우회하는 게 포팅보다 훨씬 싸다** — 대신 생태계 호환성으로 값을 치르고, "임의 프로젝트를 빌드"가 약속인 wc-exe에겐 그 청구서가 곧 핵심 질문이다. **단, 이 24개는 vite 5.4의 shipped `dist/node` 기준이다.** 실제로 포팅하면 얼마가 남는지는 vrowzer가 답했다 — 16개, 대신 25k줄 포크(아래 《실증 사례: vrowzer》).

#### React 시험 결과 — rolldown은 통과, rollup은 CJS에서 실패

실제 의존성이 있는 프로젝트(`test/fixtures/sample-react-app`: React 18 + react-dom, TSX, CSS import)로 시험했더니 **두 파이프라인이 깨끗하게 갈렸다.**

| 픽스처            | rollup (vite 5)     | rolldown (vite 8)     |
| ----------------- | ------------------- | --------------------- |
| vanilla TS        | ✅ 314ms · 413 B    | ✅ 161ms · 384 B      |
| 동적 `import()`   | ✅ 440ms · 청크 2개 | ✅ 160ms · 청크 2개   |
| 공유 청크 preload | ✅ 414ms · 청크 4개 | ✅ 231ms · 청크 4개   |
| **React**         | ❌ **실패**         | ✅ **470ms · 141 KB** |

- **rolldown은 React를 빌드하고 결과가 동작한다.** 런타임 검증 통과 — 컴포넌트가 마운트되고 스타일시트가 적용되고 클릭 시 카운터가 증가한다(= JSX·hooks·state 정상). bare specifier 해석, 조건부 `exports` 맵, **CJS→ESM interop**이 전부 통했다.
- **rollup은 예측한 그 지점에서 실패한다**: `RollupError: "useState" is not exported by "node_modules/react/index.js"`. React가 CommonJS로 배포되고 rollup은 `module.exports`를 자체적으로 소비하지 못한다 — `@rollup/plugin-commonjs`가 필요하고, 그 플러그인의 의존 체인(`glob`·`resolve` 등)은 rolldown이 요구했던 것과 같은 사전 번들링을 또 요구한다. rolldown은 oxc로 CJS를 native 처리해 이 문제가 아예 없다.
- **rollup 경로는 고칠 가치가 없다.** rolldown은 oxc로 CJS를 native 처리해 이 문제가 아예 없다. 이 CJS 갭이 결국 rollup 경로를 걷어내는 두 근거 중 첫 번째가 됐다(아래 «rolldown 단일화»).

**충실도**: React 번들 JS가 141,063 B로 **네이티브 `vite build`(142,671 B)의 1% 이내**다(더 작은 건 modulepreload 폴리필이 없어서). 같은 머신 네이티브 vite가 970ms인데 브라우저 rolldown 번들 버스트는 505ms — 다만 PoC가 하는 일이 더 적으므로 동일 비교는 아니다.

**실제 의존성을 풀려면 무엇이 필요했나** (전부 실제로 부딪혀 추가): ① **지연 VFS** — node_modules 2,150개 파일을 다 받으면 빌드보다 오래 걸려서, 경로 매니페스트만 미리 받고(해석은 동기 유지) 내용은 그래프가 닿는 파일만 fetch ② **조건부 `exports` 맵** — `browser → import → module → default → require` 순서 + 단일 `*` 패턴, `react/jsx-runtime`·`react-dom/client` 같은 서브패스 ③ **`process.env.NODE_ENV` 치환** — React가 이걸로 dev/prod 빌드를 고르는데 페이지엔 `process`가 없다(vite의 `define`이 하는 일) ④ **JSX** — rollup 경로는 esbuild `jsx:'automatic'`, rolldown은 자동 추론.

#### 동적 `import()` 청킹 — 양쪽 다 분리되지만 한 가지 미비

`test/fixtures/sample-dynamic-app`으로 버튼 뒤에 `await import('./lazy')`를 두고 시험했다. **두 번들러 모두 진짜 별도 청크를 만든다.** 하네스가 두 방향으로 검증한다 — 정적으로(lazy 마커가 정확히 한 청크에만 있고 **엔트리엔 없으며**, 모든 `import()` 대상이 디스크에 존재) 그리고 런타임으로(클릭 시 청크를 실제로 fetch해 export가 렌더됨).

|           | 네이티브 vite 5 | rollup 경로             | rolldown 경로      |
| --------- | --------------- | ----------------------- | ------------------ |
| 엔트리    | 2346 B          | 591 B                   | 560 B              |
| lazy 청크 | 76 B            | **76 B — 바이트 동일**  | 64 B               |
| CSS       | 159 B           | **159 B — 바이트 동일** | 215 B (unminified) |

rollup 경로는 lazy 청크와 CSS **둘 다 진짜 `vite build`와 바이트 동일**하다.

**엔트리 차이는 미관이 아니라 기능이다.** vite의 2346 B 엔트리엔 modulepreload 폴리필과 **`__vitePreload`**가 들어있고, 후자가 모든 동적 import를 감싸 **그 청크의 의존성까지 병렬로 preload**한다. PoC는 맨 `import()`만 emit한다. 이 픽스처의 lazy 청크는 의존성이 없어 차이가 없지만, 공유 청크가 있는 실제 앱에선 vite가 피하는 **요청 워터폴**을 PoC는 그대로 맞는다. 정직한 미비점이라 다음 할 일에 넣었다.

**알아둘 차이 하나**: oxc(rolldown의 minifier)는 문자열 리터럴을 **백틱 템플릿**으로 emit한다 — esbuild가 `import("./lazy-BymLrvT9.js")`를 쓰는 자리에 ``import(`./lazy-hLdNd2Sa.js`)``. 따옴표만 받는 청크 참조 검사는 **정상 빌드를 실패로 오탐**하는데, 이 하네스가 정확히 그걸 겪었다.

#### lightningcss 붙이기 — 되지만 두 번째 wasm은 공짜가 아니다

vite 8이 CSS를 lightningcss로 minify하므로 rolldown 경로에 `lightningcss-wasm`을 붙여 맞췄다. **배선은 rolldown보다 훨씬 쉬웠다** — ESM 진입점 하나에 wasm이 모듈 URL 기준으로 해석되고, 유일한 bare import(`napi-wasm`, 의존성 없는 단일 ESM 파일)는 import map 항목 하나로 끝. **사전 번들링 불필요.**

동작하고 출력도 좋다: **870 B(unminified) → 666 B**로, esbuild의 673 B보다 **7 B 더 작다**(선언 순서 재배치, `transparent`→`#0000` 같은 추가 축약).

**그런데 두 번째 wasm을 페이지에 올리면 빌드가 느려진다.** 같은 픽스처·같은 머신에서 ON/OFF를 **교차로 4쌍** 측정:

|                                   | 툴체인 init | 번들 버스트 | CSS   |
| --------------------------------- | ----------- | ----------- | ----- |
| rolldown + lightningcss           | 1001–1074ms | 344–393ms   | 666 B |
| rolldown 단독 (`--no-css-minify`) | 478–527ms   | 154–171ms   | 870 B |

init이 두 배(+~500ms, lightningcss 자체 인스턴스화 — 예상됨)인 건 그렇다 치고, **번들 버스트도 두 배 이상(+~190ms)** 늘어난다. 800바이트 CSS를 변환하는 데 190ms가 걸릴 수는 없으니, 변환 자체가 아니라 **페이지에 wasm 인스턴스가 둘 있는 비용**으로 보인다. 4쌍 전부 일관되므로 노이즈가 아니다.

**판단**: 작은 스타일시트에선 나쁜 거래다 — **204 B 줄이려고 ~690ms**를 쓴다. CSS가 무거운 프로젝트에서만 값을 한다. rolldown 경로는 vite 8을 반영하는 게 목적이므로 lightningcss를 **기본 ON**으로 두고 `--no-css-minify`로 끌 수 있게 했다(번들러 단독 측정을 복구하는 용도로도 필요하다).

#### `__vitePreload` 상당물 — 구현했고 워터폴이 사라진다

맨 `import()`만 emit하면 브라우저는 lazy 청크의 의존성을 **그 청크를 받아 파싱한 뒤에야** 알게 된다 — 단계마다 왕복이 하나씩 는다. vite는 `__vitePreload`가 대상의 의존성에 `<link rel="modulepreload">`를 먼저 꽂아 이걸 없앤다. PoC도 `__wcPreload`로 같은 일을 하게 했다.

`test/fixtures/sample-preload-app`이 워터폴을 실제로 만든다: 동적 import 대상 둘(`featureA`/`featureB`)이 모두 `./shared`를 정적 import → 번들러가 `shared`를 별도 청크로 끌어올리고, feature 청크가 그걸 의존한다.

**측정**(청크 요청에 인위적 200ms 지연, 교차 A/B 3쌍, 클릭→렌더 시간):

|          | preload ON        | preload OFF (`--no-preload`) |
| -------- | ----------------- | ---------------------------- |
| rollup   | 230 / 237 / 241ms | 439 / 442 / 444ms            |
| rolldown | 234 / 236 / 238ms | 435 / 441 / 444ms            |

**왕복 2회 → 1회, ~1.9× 빨라지고 ~200ms(한 홉)를 통째로 절약**한다. 주입한 지연의 1배 대 2배로 이론값과 정확히 맞는다.

emit 형태도 vite와 같다: `__wcPreload(() => import("./featureA-….js"), ["/assets/shared-….js"])`. 네이티브 vite도 같은 픽스처에서 같은 청크 그래프를 만들고(그 `shared` 청크는 우리 것과 해시까지 바이트 동일) 엔트리에 `modulepreload`와 shared 청크 이름을 싣는다 — 즉 파일 배치뿐 아니라 **동작까지** 일치한다.

**rolldown은 `renderDynamicImport`를 호출하지 않는다.** rollup 경로는 vite와 같은 2단계 방식(`renderDynamicImport`로 마커를 넣고, 최종 파일명이 확정되는 `generateBundle`에서 의존성 목록으로 치환)을 쓴다. rolldown에선 이 훅이 아예 안 불려서, preload를 켰는데도 엔트리가 감싸이지 않은 채(766 B, 헬퍼 없음) lazy 로드가 442ms — 워터폴 그대로였다. `generateBundle`은 호출되므로, 그쪽에서 이미 emit된 `import("./chunk.js")`를 직접 재작성하는 폴백을 넣어 228ms로 rollup과 동률을 만들었다.

**해시 정합성 — 캐시 오염 버그였고, 고쳤다.** 두 preload 경로 모두 `generateBundle`에서, 즉 번들러가 **해시를 계산한 뒤에** 코드를 바꾼다(rollup은 마커 치환+헬퍼 삽입, rolldown은 재작성 전체). 그래서 청크 이름이 더 이상 그 바이트를 식별하지 못했다. 이론이 아니라 실제로 재현된다 — 같은 픽스처를 preload 켜고/끄고 빌드하면 `main-BuyLOJ80.js`가 **1263 B와 766 B 두 내용**으로 나왔다. URL로 캐싱하는 모든 것(CDN·브라우저·서비스워커)이 한쪽 빌드의 바이트를 다른 쪽으로 내주게 된다.

수정: 재작성된 청크를 **재해시해 이름을 바꾸고** HTML 참조도 함께 갱신한다. 다른 청크가 이름으로 import하는 청크를 renaming하려면 그 importer들까지 연쇄 재해시가 필요한데, 픽스처엔 그런 경우가 없으므로 **참조가 끊긴 산출물을 내보내느니 throw**하게 했다. 수정 후 이름이 제대로 갈라진다(rolldown `main-25dff951.js` vs `main-BuyLOJ80.js`, rollup `main-d5c07138.js` vs `main-aC2H4x2L.js`). 재해시 이름은 sha256 앞 8자리 hex라 번들러가 지은 이름과 눈으로 구분되고, 같은 입력을 다시 빌드하면 같은 이름이 나온다.

하네스가 이 불변식을 직접 검사한다 — 헬퍼를 담은 청크는 파일명의 해시가 그 바이트의 해시와 같아야 한다. 재해시를 끄면 이 검사가 실패하므로 실효성이 있다. vite는 rollup의 해시 플레이스홀더로 애초에 최종 내용을 해시해서 같은 결과에 도달한다 — 후처리 파이프라인에선 사후 renaming이 그 등가물이다.

**다음에 결판낼 것**: ① 한 머신에서 WebContainer `npm run build`와 동일 조건 비교 — 다만 지금 그대로 재면 "빌드 단계만"의 비교라는 점에 주의(미결 1) ② 플러그인 호환성·sourcemap·multi-page. 자세한 내용은 `poc/vite-build-intercept/README.md`.

#### install 없는 인터셉트 — 벽이 생각보다 낮을 수 있다 (2026-08 실측)

warm 실행을 분해하면 인터셉트가 대체하는 조각이 가장 작다는 게 드러난다:

| 단계                          | 실측  | 인터셉트가 대체하나   |
| ----------------------------- | ----- | --------------------- |
| WebContainer 부팅             | ~5.4s | ❌                    |
| `npm install`(OPFS 캐시 히트) | 0.30s | ❌ — 애초에 하지 않음 |
| 빌드                          | ~1.6s | ✅                    |

그런데 확정 4의 "5단계 lifecycle scripts가 벽"은 **"`npm install`을 충실히 재현한다"** 에 대한 판정이다. **"인터셉트 빌드에 필요한 모듈 그래프를 만든다"** 는 훨씬 작은 문제일 수 있다. React 픽스처로 재봤다:

|                                |                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------- |
| 설치된 패키지                  | **71개**                                                                         |
| install 훅을 가진 패키지       | **3개** — `csstype`(`prepublish`), `esbuild`(`postinstall`), `rollup`(`prepare`) |
| 그중 인터셉트 빌드에 걸리는 것 | **0개**                                                                          |
| 런타임 의존성 클로저           | **5개** — react, react-dom, scheduler, loose-envify, js-tokens                   |
| 크기: 전체 vs 클로저           | **44MB** vs **5.0MB**                                                            |

`prepublish`·`prepare`는 install에 아예 안 돈다. 유일한 실제 훅인 `esbuild`의 `postinstall`은 **네이티브 바이너리를 받아오는 것**인데 이 파이프라인은 네이티브 esbuild를 쓰지 않는다. 그리고 71개 중 **66개가 devDependency**다(vite·rollup·`@babel`·`caniuse-lite`…) — 인터셉트는 vite를 실행하지 않으므로 설치할 이유가 없다.

그래서 형태는 보인다: **호스트가 Node이므로** lockfile을 읽고 → 레지스트리에서 타르볼을 받아 → **메모리에서 풀어** → `--vfs=memfs`가 이미 채우는 그 볼륨에 직접 넣으면 디스크를 건드리지 않는다. 비어 있는 칸은 **바이트를 `node_modules`가 아니라 레지스트리에서 가져오는 부분 하나**뿐이고, §5의 cacache 타르볼 캐시가 그 절반이다.

**증명된 게 아니다.** 리스크 둘이 그대로다: ① 픽스처 하나에서 "훅이 안 걸린다"를 일반화하는 건 이 탐색이 이미 두 번 저지른 실수다 ② npm의 트리 해석(peer deps·`overrides`·optional/platform deps·workspaces)을 재현하지 못하면 빌드가 **조용히** 깨진다(위 «하이브리드 착지점»의 본체 비용).

#### 훅은 비어 있고, 비용은 옮겨갔다 (10개 프로젝트 실측)

①의 리스크를 먼저 줄였다. `bench/install-shape.mjs`가 설치된 프로젝트를 받아 **런타임 클로저**(루트의 `dependencies`+`optionalDependencies`를 재귀, devDependencies는 제외 — 인터셉트는 프로젝트의 vite를 실행하지 않으므로)와 **레지스트리 설치 시 실제로 도는 훅**(`preinstall`·`install`·`postinstall` + `binding.gyp`의 암묵적 `node-gyp rebuild`; `prepare`·`prepublish`는 published 타르볼에 안 돌므로 제외)을 센다.

`npm create vite@latest`(vite 8.2.2) 템플릿 7개 + 현실적 런타임 의존성을 얹은 앱 2개 + 이 저장소의 vite 5 픽스처:

| 프로젝트         | pkgs | 클로저 | 훅  | 클로저 내 훅 | node_modules | 클로저  | 전송분  |
| ---------------- | ---- | ------ | --- | ------------ | ------------ | ------- | ------- |
| vanilla-ts       | 16   | 0      | 0   | 0            | 53.0 MB      | 0.0 MB  | 0.0 MB  |
| react-ts         | 27   | 3      | 0   | 0            | 80.2 MB      | 7.2 MB  | 7.2 MB  |
| vue-ts           | 48   | 23     | 0   | 0            | 72.4 MB      | 16.1 MB | 10.4 MB |
| svelte-ts        | 50   | 0      | 0   | 0            | 66.2 MB      | 0.0 MB  | 0.0 MB  |
| preact-ts        | 89   | 1      | 0   | 0            | 70.3 MB      | 1.5 MB  | 0.3 MB  |
| lit-ts           | 22   | 6      | 0   | 0            | 55.8 MB      | 2.8 MB  | 0.7 MB  |
| solid-ts         | 77   | 4      | 0   | 0            | 71.5 MB      | 3.4 MB  | 1.2 MB  |
| react-app        | 112  | 76     | 0   | 0            | 129.5 MB     | 53.5 MB | 33.6 MB |
| vue-app          | 135  | 118    | 0   | 0            | 135.2 MB     | 79.2 MB | 38.4 MB |
| sample-react-app | 67   | 5      | 1   | 0            | 44.4 MB      | 4.7 MB  | 4.7 MB  |

**열 개 전부, 런타임 클로저의 훅이 0개다.** 어디서든 발견된 훅은 단 하나 — vite 5 픽스처의 `esbuild` `postinstall`이고, devDependency이며, 이 파이프라인이 절대 로드하지 않는 네이티브 바이너리를 받아온다.

**vite 8 프로젝트들은 훅이 아예 없다.** 네이티브 바이너리(`@rolldown/binding-*`·`lightningcss-linux-*`·`@oxlint/*`)가 `postinstall` 다운로드가 아니라 **플랫폼별 `optionalDependencies`**로 온다. 생태계가 그쪽으로 옮겨간 것이고, 확정 4가 쓰일 당시보다 벽이 낮아진 이유다.

**클로저 크기는 프로젝트에 따라 크게 다르다.** 템플릿은 작지만(0~23개, 53~80MB 중 16MB 이하), 현실적인 앱은 뒤집힌다 — 직접 `npm install`한 것은 런타임 의존성이므로 `vue-app`의 클로저가 135개 중 118개, 79.2MB(필터 후 **38.4MB**)다.

이 수치는 **전량을 미리 옮겨야 할 때** 문제가 된다. 이 측정 직후 `--vfs=memfs`에 lazy fault-in을 붙여 그 전제가 깨졌으므로(§9), 지금 읽어야 할 방식은 "38.4MB를 옮겨야 한다"가 아니라 **"최악의 경우 38.4MB 안에서 그래프가 닿는 만큼"**이다 — react-app 실측으로는 60.9MB 중 0.7MB였다.

**즉 install 없는 인터셉트는 정확성 쪽에선 열려 있다.** 남는 건 전송량인데, **그 벽도 lazy fault-in이 대부분 무너뜨렸다**(위 참조): react-app에서 그래프가 실제로 읽은 건 60.9MB 중 **0.7MB**다. 즉 호스트가 받아와야 할 것은 클로저 전체가 아니라 **그래프가 닿는 것**이고, 타르볼 단위로 받는다면 "닿는 패키지"의 타르볼이다.

한 가지 모양이 여전히 옳다: **풀어놓은 트리가 아니라 타르볼을 캐싱하는 것.** §5의 cacache가 이미 그렇게 하고 있다 — 백신 비용은 **파일 개수당** 발생하는데, 40MB의 타르볼은 수백 개 파일이고 풀어놓은 트리는 13,340개다.

**여전히 못 잰 것**: 프로젝트 10개 중 7개가 스캐폴드다. `sharp` 같은 네이티브 애드온도, 모노레포/workspaces도 없다. 훅 0개는 **증거이지 증명이 아니다.** 그리고 `vanilla-ts`·`svelte-ts`의 클로저 0은 문자 그대로 맞지만 조용히 오해를 만든다 — Svelte 컴파일러는 devDependency라, `.svelte`를 실제로 다루는 빌드는 런타임 클로저보다 많이 필요하다. 이 수치는 **"지금의 PoC가 필요로 하는 양"** 이지 "완성된 도구가 필요로 하는 양"이 아니다.

#### rolldown 단일화 — rollup 경로를 걷어냈다 (2026-08)

PoC에는 vite 5~7을 반영하는 `@rollup/browser` + `esbuild-wasm` 파이프라인이 함께 있었다. 걷어냈다. 근거를 남겨두는 이유는, 가장 그럴듯한 반론이 성립하지 않기 때문이다 — "우리 사용자는 vite 5를 쓰니 vite 5 파이프라인이 필요하다."

**레지스트리 사실** (2026-08 확인): vite `latest` = **8.2.2**(deps: `rolldown`·`lightningcss`·`postcss`). vite 8.0.0은 **2026-03-12** 출시로 rolldown 기반 첫 메이저다. 반면 `previous` 태그인 **7.3.6**(2026-06-25)은 여전히 `rollup`·`esbuild`에 의존하고, 6·5도 마찬가지다. **즉 필드의 대다수는 아직 rollup 계열이다.** 그러니 "vite 8부터 rolldown이니 rollup은 무의미"라는 논리만으로는 제거가 정당화되지 않는다.

정당화하는 건 다른 사실이다:

> **인터셉트에서는 프로젝트의 vite 버전이 번들러를 고르지 않는다.** 우리는 프로젝트의 vite를 실행하지 않고 그 파이프라인을 **대체**한다.

실측이 이미 있었다 — React 픽스처는 `vite: ^5.4`를 핀하는데 rolldown으로 빌드되고, 네이티브 `vite build`(5.4.21) 출력의 **1% 이내**다(141,063 vs 142,671 B). 그러니 번들러는 하나면 되고, 둘은 대등하지 않다:

|                             | rolldown                          | rollup + esbuild-wasm                             |
| --------------------------- | --------------------------------- | ------------------------------------------------- |
| React(CJS 의존성)           | ✅ oxc가 native 처리              | ❌ `@rollup/plugin-commonjs` 필요                 |
| 파일시스템을 넘겨줄 수 있나 | ✅ `--vfs=memfs`                  | ❌ 플러그인 훅뿐                                  |
| 해석 정확성                 | rolldown 자체 리졸버, 정확        | 수제 리졸버 고착 → `browser`·`imports` **오해석** |
| 번들 버스트(바닐라)         | **144 / 153ms**                   | 366 / 511ms                                       |
| COOP/COEP                   | 필요                              | **불필요**                                        |
| 다운로드                    | 10MB wasm + 1.5MB JS + 1.2MB 워커 | 작음                                              |

마지막 두 줄이 rollup 경로의 전부였는데, 둘 다 wc-exe에선 값을 못 한다. 서버가 이미 COOP/COEP를 붙이고(WebContainer도 어차피 요구한다), 번들러는 로컬 vendored라 빌드마다 받지 않는다. 남은 건 **React를 못 빌드하고, 의존성을 올바로 해석하는 유일한 VFS 모드를 못 쓰고, `build.js`를 이중화하는** 파이프라인이었다.

**제거 결과**: PoC에서 **118줄**이 빠졌다(`build.js` −85, `run.mjs` −33) — `transform`·`renderChunk`의 `needsEsbuild` 분기, 두 번째 CSS minifier, 두 번째 preload 전략(`renderDynamicImport` + 마커 치환; rolldown은 이 훅을 아예 호출하지 않는다). **픽스처 5개의 출력이 제거 전과 바이트 동일**하다.

**대신 두 가지 주장이 기록으로만 남는다** — 트리에 실증하는 코드가 없어졌으므로:

1. **브라우저 빌드가 COOP/COEP 없이도 가능하다** — rollup 경로가 그걸 보여줬다. WebContainer·container2wasm·rolldown은 전부 요구한다. §7·§9에서 "인터셉트의 개방성" 논거로 쓰던 항목이라, 이제 강도가 한 단계 내려간다.
2. **minify된 CSS가 네이티브 vite 5와 바이트 동일** — esbuild minifier가 냈던 결과(673 B). lightningcss는 다른 선택을 하므로 이어지지 않는다.

둘 다 "포기해도 되는가"를 따져서 내린 결정이지, 없었던 셈 치는 게 아니다.

### 실증 사례: vrowzer — vite를 진짜로 포팅하면 얼마인가 (2026-08 조사)

[vrowzer](https://github.com/kazupon/vrowzer)(kazupon, MIT)는 **vite dev server를 브라우저에서 돌린다.** 위 PoC가 "vite를 우회한다"를 택한 바로 그 자리에서 **정반대로 vite를 포팅**했으므로, 포팅 비용의 실제 청구서가 된다.

**포크는 진짜다.** `refers/vite`가 vitejs/vite git submodule이고 `TODO.md` 첫 줄이 "Porting status from refers/vite"다. `@vrowzer/vite-dev-server`의 `src` 아래 `.ts` 116개 · **약 39,758줄** — vite의 `src/node` 트리를 옮겨 고친 것이다.

**그런데 빌드는 비어 있다. 그것도 하드코딩된 dev 전용이다.**

- `rolldown.config.ts`: `'process.env.NODE_ENV': JSON.stringify('development')` — 주석에 _"vrowzer always runs in dev mode (resolveConfig uses this for isProduction)"_.
- 같은 파일에서 공개 엔트리 `src/node/index.ts`가 **주석 처리**돼 있다 — _"this entry isn't used for vrowzer"_. 빌드되는 건 `cli`와 `internal`뿐.
- `src/node/build.ts`는 764줄로 존재하지만 `resolveBuildPlugins`의 pre/post가 **전부 주석**이다(`TODO(kazupon): implement later`) — `prepareOutDirPlugin`, `buildImportAnalysisPlugin`, `buildEsbuildPlugin`, `terserPlugin`, `manifestPlugin`, `buildReporterPlugin`, `licensePlugin`. `build()` 오케스트레이션 함수 자체가 export 목록에 없다.

다만 **구조는 살아 있다.** `plugins/index.ts`가 `isBuild`/`anyEnvBundled` 분기와 `await import('../build')`를 그대로 유지하고, 빌드 플러그인 자리들이 정확한 위치에 주석으로 남아 있다. `build.ts`의 타입·옵션·경로 계산부(`resolveBuildEnvironmentOptions`, `toOutputFilePathInJS/InCss/InHtml`, `BuildEnvironment`)는 이미 `config.ts`·`asset.ts`·`css.ts`가 쓴다. 재설계가 아니라 **주석 해제 + 플러그인 개별 포팅**이다.

#### npm install은 어떻게 다루나 — 우회가 아니라 이관이다

**vrowzer도 브라우저에서 `npm install`을 하지 않는다.** 대신 **빌드 타임에 Node에서 매니페스트를 만들어** 브라우저에 넘긴다. `schema/vrowzer-manifest.json`이 그 계약이다:

```json
{
  "files":       { "/src/main.tsx": "./src/main.tsx", ... },
  "nodeModules": { "/node_modules/react/package.json": "...", ... },
  "activeFile":  "/main.tsx"
}
```

`packages/vite-plugin/src/manifest-generate.ts`(698줄)가 **로컬 `node_modules`에서** 이걸 만든다. 하는 일은 셋이다:

1. **의존성 클로저만 걷는다**(`collectDependencies`) — 루트에서만 devDependencies를 보고(기본은 `includeDevDependencies: false`), 그 아래로는 `dependencies`만 재귀한다.

   ```ts
   const deps = isRoot
     ? [
         ...Object.keys(pkg.dependencies || {}),
         ...Object.keys(pkg.devDependencies || {}),
       ]
     : Object.keys(pkg.dependencies || {})
   ```

2. **CJS 패키지를 rolldown으로 ESM 사전 번들**(`bundleCjsPackages`) — `/node_modules/.vrowzer-esm/`에 넣고 **그 패키지의 `package.json`을 재작성**해 `exports`가 번들 결과를 가리키게 한다(`pkgExportsMap.get(pkgName)![subpath] = '../.vrowzer-esm/${entryName}.js'`).
3. **optimizer를 끈다** — `disableDepsOptimizer: true`. TODO.md 그대로: _"CJS packages (React) are pre-bundled to ESM by `gen:manifest` instead."_

실제 결과(그들의 React e2e 픽스처): 소스 7개 + nodeModules 41개 항목 = **패키지 4개**(`.vrowzer-esm` 26 files, `scheduler` 13, `react` 1, `react-dom` 1). react·react-dom은 원본 파일이 **하나도** 안 들어가고 재작성된 package.json만 들어간다.

**그러니 이건 우회법이 아니라 이관이다.** 매니페스트를 만드는 머신에는 설치가 끝나 있어야 한다. vrowzer에게 문제가 안 되는 이유는 제품 모양이 다르기 때문이다 — 운영자가 환경을 **한 번 준비해** 최종 사용자 브라우저로 보내고, 최종 사용자는 npm을 만날 일이 없다. **wc-exe는 사용자가 개발자 본인이고, 문제가 되는 디스크가 그 사람 디스크다.** "미리 설치해두세요"는 답이 될 수 없다.

**다만 절반은 그대로 쓸 수 있다.** 위 《install 없는 인터셉트》에서 비어 있던 칸과 맞춰보면:

| 조각                   | vrowzer                                  | wc-exe에 필요한 것                                                               |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| 어느 패키지가 필요한가 | ✅ `collectDependencies`                 | 그대로 차용 가능                                                                 |
| CJS를 어떻게 다루나    | ✅ rolldown 사전 번들 + `exports` 재작성 | 차용 가능 — 단 memfs 모드에선 rolldown이 CJS를 직접 처리하므로 **불필요할 수도** |
| 파일을 **어디서** 얻나 | ❌ 로컬 디스크                           | **레지스트리 → 메모리 → 볼륨** ← 새로 써야 할 부분                               |
| lifecycle scripts      | ❌ 무시                                  | 실측상 인터셉트 빌드엔 거의 무관                                                 |

#### node 빌트인 24개 → 16개, 대신 포크로 지불

vrowzer가 실제로 import하는 node 빌트인은 **16개**다:

```
45 node:path   28 node:fs   20 node:fs/promises   8 node:url   5 node:module
 4 node:perf_hooks   3 node:util   3 node:os   2 node:events   2 node:buffer
 1씩: timers/promises, readline, https, http, dns, crypto
```

`child_process`·`worker_threads`·`net`·`tls`·`inspector`가 **없다.** 하지만 이건 "vite가 그걸 안 쓴다"가 아니라 **포크해서 그 코드 경로를 잘라냈다**는 뜻이고, 남은 16개는 `resolve.alias`로 `@vrowzer/node-polyfill` / `@vrowzer/fs`(memfs) / `pathe`에 넘긴다. **벽은 우리가 생각한 것보다 낮지만, 넘는 값을 포크로 지불한 것**이다.

**빌드 전용이면 더 작다.** 39,758줄 중 dev 서버 전용이:

| 부분                                                                         | 줄 수        |
| ---------------------------------------------------------------------------- | ------------ |
| `node/server/` (미들웨어·HMR)                                                | 10,174       |
| `shared/` (hmr, moduleRunnerTransport)                                       | 1,871        |
| `client/` (HMR 클라이언트·overlay)                                           | 1,039        |
| `service-worker.ts`·`web-worker.ts`·`preview.ts`·`watch.ts`·`module-runner/` | 1,799        |
| **빌드에 불필요 소계**                                                       | **≈ 14,900** |

남는 ≈24,900줄에 빌드 전용 플러그인 3~4k를 더해 **25k~28k줄** 규모다. PoC의 676줄(`browser/build.js`)과 나란히 놓고 볼 숫자다.

#### 그래도 wc-exe에는 포크가 맞지 않는다 — 규모가 아니라 버전 때문

- vrowzer의 vite는 **자기 것**이다. 자기 프리뷰 환경에서 자기가 핀한 vite 하나를 돌린다. 포크가 합리적이다.
- wc-exe의 vite는 **남의 것**이다. 사용자 프로젝트가 `vite: ^5.4`를 물고 `@vitejs/plugin-vue`·tailwind를 물고 온다. 포크는 vite 버전 **하나**만 준다.

포크를 뜨는 순간 약속이 "임의의 프로젝트를 빌드"에서 "**우리가 포크한 vite 버전에서 동작하는 프로젝트를 빌드**"로 바뀌고, upstream에 영원히 리베이스해야 한다. WebContainer 경로는 **프로젝트가 가져온 vite를 그대로 실행**한다 — 포크가 못 주는 것이 정확히 이것이다. 브라우저에서 도는 `vite build`는 upstream vite가 할 일이고, 그때 공짜로 받는다.

#### 포크와 무관하게 훔칠 것 두 가지

1. ~~**fs-proxy memfs (`@vrowzer/rolldown`)**~~ — **이식 완료(`--vfs=memfs`). 아래 별도 절 참조.**
2. **OXC 기반 `vite.config.ts` 정적 추출 (`@vrowzer/vite-plugin`)** — `extract.ts`(770줄)가 OXC로 `vite.config.ts`를 파싱해 플러그인 호출·import를 추출·재생성하고, 반환 타입에 `unsupported: string[]`을 둬서 **못 다루는 걸 조용히 넘기지 않고 신고**한다. `prebundle.ts`(270줄)가 그 플러그인들을 rolldown으로 사전 번들한다. **이게 Node에서, 빌드 전에 돈다** — wc-exe는 CLI가 Node라 같은 탈출구를 이미 갖고 있다. PoC의 가장 아픈 경계("`vite.config.ts`를 통째로 무시한다")를 25k줄 포크 없이 좁히는 저비용 수단으로 보인다.

**부수 재고**: `@vrowzer/node-polyfill`은 브라우저 테스트가 붙은 독립 MIT 패키지(16개 모듈). 나중에 node 빌트인 shim이 필요해지면 직접 짜는 대신 쓸 수 있다.

### fs-proxy memfs 이식 결과 (`--vfs=memfs`, 2026-08 구현·실측)

vrowzer의 유일한 이식 후보를 실제로 붙였다. `@rolldown/browser`의 wasi 바인딩이 memfs 볼륨을 만들어 `/`에 preopen하므로, 프로젝트를 그 볼륨에 써넣으면 **rolldown의 네이티브 리졸버가 진짜 디스크처럼 walk한다.** 상세는 `poc/vite-build-intercept/README.md`.

**동작하고, 출력이 바이트 동일하다.** 픽스처 4개 전부 빌드되고, 방출된 파일이 플러그인 경로와 **콘텐츠 해시까지** 같다(React `main-vIIrpq_x.js` 141,063 B). 즉 bare specifier 해석, 조건부 `exports` 맵, 서브패스, CJS→ESM interop을 **rolldown이 대신 해도 결과가 같다**. 손으로 짠 리졸버는 충실한 재구현이었고, 이제 그걸 유지할 필요가 없다.

**대가는 지연 VFS라고 생각했는데, 아니었다.** "번들러의 fs 호출이 동기라 미리 다 채워야 한다"는 `fetch`에 대해서만 참이고 페이지에 대해선 거짓이다 — **동기 XMLHttpRequest**가 여전히 동작한다(COOP/COEP 아래 로컬 요청 3ms 실측). 그게 웹 앱에서 나쁜 이유(메인 스레드 블로킹)는 UI가 없는 헤드리스 빌드 러너에는 적용되지 않는다.

훅 지점은 추측이 아니라 rolldown을 계측해서 정했다 — `readFileSync`는 아예 안 부르고 디스크립터 API(`lstatSync`·`openSync`·`readSync`·`fstatSync`·`closeSync`·`realpathSync`)로 **페이지 자신의 `memfs.fs` 객체**를 친다. 페이지의 WASI와 wasi 워커의 fs-proxy가 둘 다 그 객체에 떨어지므로 메서드만 패치하면 양쪽이 덮인다.

그래서 기본 채우기는 이제 lazy다: **매니페스트와 디렉터리**만 미리(디렉터리가 없으면 ENOENT를 정직하게 보고해야 해석이 된다), 소스는 어차피 그래프가 다 닿으니 즉시, 의존성 내용은 ENOENT에서 fault-in. 내용을 지어내지 않는다 — 진짜 바이트를 얻거나 원래 에러가 난다. `--eager`로 예전 전면 전송을 복원해 A/B할 수 있다.

| React 픽스처    | 플러그인 VFS  | memfs (lazy)  | memfs `--eager` |
| --------------- | ------------- | ------------- | --------------- |
| 파일 앞에 놓기  | 16–17ms       | 19–20ms       | 299–304ms       |
| 번들 + generate | 183–196ms     | 209–218ms     | 194–205ms       |
| **총 in-page**  | **326–337ms** | **358–367ms** | **624–645ms**   |

fault-in 비용은 번들 버스트 **안에** 떨어진다(그래서 그 열이 184→213ms). 2,255개 경로 매니페스트 중 **실제로 읽은 건 19개 파일 0.2MB**, 블로킹 XHR 19–20ms다.

규모에서 더 벌어진다. 실제 의존성을 얹은 `npm create vite` React 앱(경로 14,997개, 필터 후 60.9MB):

| react-app      | memfs (lazy)       | memfs `--eager`                   |
| -------------- | ------------------ | --------------------------------- |
| 파일 앞에 놓기 | 64ms               | 1,511ms (fetch 1,357 + write 153) |
| 읽어들인 양    | **32파일 · 0.7MB** | 전량 8,655파일 · 60.4MB           |
| **총**         | **497ms**          | **2,012ms**                       |

**4× 빠르고, eager가 옮기는 양의 1.2%만 읽으며**, 출력은 바이트 동일하다. 즉 `--vfs=memfs`의 대가는 1.8×가 아니라 **약 9%**이고, 그러면서 의존성을 올바로 해석하는 쪽이다.

(그 앱은 `.png`·`.svg` import를 걷어내야 빌드된다 — 애셋 파이프라인은 두 모드 모두 미구현이고, 채우기 전략과 무관한 다음 갭이다.)

아래 표는 `--eager`일 때의 이야기다.

| React 픽스처     | 플러그인 VFS | memfs VFS     |
| ---------------- | ------------ | ------------- |
| 파일을 앞에 놓기 | 16–17ms      | 307–321ms     |
| 번들 + generate  | 191–196ms    | 199–214ms     |
| **총 in-page**   | **355ms**    | **634–653ms** |

**번들 버스트는 그대로다** — rolldown은 바이트가 어디서 왔는지 신경 쓰지 않는다. 차이는 전부 VFS 단계고, 그 안에서 전송:memfs 쓰기가 약 90:10이다(278ms + 28ms). **memfs 문제가 아니라 전송 문제다.** 의존성이 없는 바닐라 픽스처에선 둘이 무승부(299–303ms vs 280–308ms).

**전송량의 2/3는 애초에 모듈이 아니었다.** 필터 없이 보내면 44.5MB인데 그중 **17.9MB가 esbuild 네이티브 바이너리 두 벌**, 약 5MB가 `.map`, 3.6MB가 `.node`다. 모듈일 수 없는 것(`.map`·`.md`·`.flow`·`.node`·`.d.ts`, 그리고 첫 1KB에 NUL이 있는 확장자 없는 파일)을 거르면 **15.2MB**로 줄고 VFS 단계가 482ms → 307–321ms가 된다. 이건 **리졸버가 아니라 콘텐츠 필터**다 — specifier가 어디를 가리키는지는 아무것도 정하지 않으므로, 이 모드가 rolldown에게 돌려준 바로 그 책임을 되가져오지 않는다.

**정작 vrowzer의 대표 패치는 필요 없었다.** fs-proxy 페이로드 상한 10KB → 10MB 확장 말이다. 논리는 빈틈없어 보였다(react-dom 130KB를 10KB 버퍼로 못 받는다). **실측으로는 아니다** — React가 **stock 10KB에서 바이트 동일하게** 빌드되고 1KB에서도 된다. 모듈 내용은 워커 프록시가 아니라 **페이지 자신의 WASI**에서 읽힌다. 이분해보면 프록시를 실제로 건너는 건 256B~1KB 사이 — 경로 문자열과 stat 결과다.

그래서 패치는 구현하되 **기본 비활성**이다. 의존성 소스를 패치해서 얻는 게 없으면 그건 순수 부채다. 플래그(`--fs-payload-bytes=`)로만 남긴 이유는 **넘쳤을 때의 증상**이다:

| 상한         | 결과                                |
| ------------ | ----------------------------------- |
| 10KB (stock) | 빌드됨                              |
| 1KB          | 빌드됨                              |
| 256B         | **렌더러가 죽음** — "Target closed" |
| 64B          | **페이지가 멈춤**, 에러 없음        |

`RangeError: payload overflow`는 코드에 있는데 **한 번도 표면에 나오지 않는다.** 언젠가 넘치는 프로젝트가 생기면 여기를 가리키는 것 없이 크래시나 정지로 나타난다 — 상시 패치할 값어치는 없고, 문서화된 탈출구 하나는 있을 값어치가 있다.

**판정: 코드가 줄지 않는다. 성격이 바뀐다.**

|                           | 플러그인 VFS          | memfs VFS                      |
| ------------------------- | --------------------- | ------------------------------ |
| 우리가 소유한 해석 의미론 | 109 코드줄            | **0**                          |
| 우리가 소유한 배관        | 지연 매니페스트+fetch | 71(페이지) + 78(호스트) 코드줄 |
| 패치한 의존성             | 없음                  | 없음                           |
| React 총시간              | 355ms                 | 634–653ms                      |

줄 수는 거의 무승부다. 바뀌는 건 **성격**이다: Node의 해석 알고리즘과 맞아야 하는 — 그리고 미결 3의 미검증 생태계 형태가 사는 — 109줄이, 맞거나 눈에 띄게 깨지거나 둘 중 하나인 ~150줄의 전송 코드로 바뀐다. 그 거래가 1.8×만큼의 값을 하는지는 아래 픽스처가 답한다.

#### 두 리졸버를 가르는 픽스처 (`sample-exports-app`)

위 거래는 수제 리졸버가 실제로 틀릴 때만 값을 한다. 그래서 픽스처를 하나 추가했다 — 로컬 패키지 4개가 각각 **`node` 파일과 `browser` 파일에 다른 마커**를 담고, `resolution-expectations.json`이 번들에 무엇이 있어야 하고 무엇이 없어야 하는지를 선언한다. 잘못 고르면 **조용히 성공**하기 때문이다: 빌드는 되고 앱은 뜨는데 잘못된 파일이 실려 나간다.

기준은 네이티브 `vite build`(5.4.21)로 먼저 확정했다 — **넷 다 browser 변형을 고른다.** 그러니 불일치는 취향이 아니라 버그다.

| 형태                                     | 네이티브 vite | 플러그인 VFS(수제)          | memfs VFS(rolldown) |
| ---------------------------------------- | ------------- | --------------------------- | ------------------- |
| 레거시 `browser` 필드, 문자열형          | browser       | ❌ **조용히 node**          | ✅ browser          |
| 레거시 `browser` 필드, 객체 remap        | browser       | ❌ **조용히 node**          | ✅ browser          |
| `imports` 필드(`#internal`, 조건부 해석) | browser       | ❌ external → 런타임 크래시 | ✅ browser          |
| `exports` 와일드카드(여러 세그먼트 횡단) | ✅            | ✅                          | ✅                  |

(걷어낸 rollup 경로도 동일하게 실패했다 — 리졸버를 공유했으니까. 그쪽은 `--vfs=memfs`를 쓸 수 없어 이 실패가 **고칠 수 없는 성질**이었고, 그게 제거의 두 번째 근거다.)

**중요한 건 `browser` 필드 두 줄이다.** 실패하지 않고 **틀리게 성공한다.** 번들은 멀쩡하고 앱은 렌더되는데, 의존성의 Node 빌드가 조용히 브라우저 번들에 링크된다. 이 PoC가 계속 잡아내는 바로 그 부류이고(generate() 전 CSS 읽기, 해시 정합성), 픽스처 말고는 막을 방법이 없는 부류다.

**미결 3의 앞 두 항목이 이걸로 정리된다**: 와일드카드는 괜찮았고, `browser` 필드는 애초에 구현조차 안 돼 있었고, `imports`도 마찬가지다. `--vfs=memfs`에서는 셋 다 우리 책임이 아니게 된다.

**들어오면서 버그 두 개를 잡았다.**

1. **의존성 스캔이 `node_modules/**/dist/`를 통째로 버리고 있었다.** `listFiles`가 *프로젝트용* 무시 목록(`dist`·`coverage`포함 — 프로젝트 자기 산출물엔 옳다)을 node_modules에도 적용했다.`dist/`에서 배포하는 패키지가 전부 안 보였고, 빌드는 경고 하나만 남기고 external import를 뱉었다. React는 우연히 안 걸렸고(`cjs/`·`umd/`에서 배포), 새 픽스처는 첫 실행에 걸렸다. **두 VFS 모드 모두 영향**을 받았다. node_modules에 별도 무시 목록을 주어 수정했고, React 볼륨이 1,552 → 1,618 파일로 늘었지만 출력은 바이트 동일하다.
2. **런타임 검사가 죽으면 static 결과가 안 보였다.** `verifyBuiltAppRuns`가 첫 셀렉터 실패에서 통째로 throw해서, 해석 실패가 `failed to find element matching selector "#counter"`로만 나타났다. 이제 중단을 problem으로 기록하고 static 결과가 살아남는다 — 위 표가 읽히게 된 게 그 덕이다.

### 하이브리드 착지점 (제안 — 미구현)

전면 대체가 아니라 **분업**. 우리는 이미 타르볼 캐시로 1~3의 일부를 가져왔으니(§5 단기+), 그 연장선이다:

| 누가                  | 무엇을                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- |
| **우리**(호스트/러너) | lockfile 읽기 → 타르볼 확보(이미 cacache에 있음) → VFS에 직접 풀기 → node_modules 트리 배치 |
| **npm/WebContainer**  | link/bin, **lifecycle scripts**, 그리고 build                                               |

**기대 효과**: npm의 resolve + 트리 재구성 오버헤드 제거 → §5 실측의 C(5.74s)와 B(0.30s) 사이 간극을 좁힌다. 지금 C가 느린 건 네트워크 때문이 아니라(이미 캐시 히트) **npm이 여전히 전체 해석·재구성을 하기 때문**이다.

**왜 lifecycle scripts는 계속 npm에 맡기는가**: 그게 5번 벽이고, 포기하면 `postinstall` 있는 패키지가 깨진다. wc-exe의 임무는 "임의 프로젝트를 그대로 빌드"이므로 충실도를 잃으면 안 된다.

**리스크 / 미해결 (이 방향의 진짜 비용)**

- npm이 만드는 `node_modules`와 우리가 만든 트리가 미묘하게 달라지면 빌드가 **조용히** 깨진다 — peer deps, `overrides`, workspaces, optional/platform deps, bin 이름 충돌. 결국 **npm의 해석 규칙을 우리가 재현**해야 하는 부분이 남고, 그게 비용의 본체다.
- 대안: npm의 **`@npmcli/arborist`**(순수 JS 트리 빌더)를 그대로 쓰고 해석은 npm에 맡긴 뒤 우리는 materialize만 하는 방법. 다만 arborist를 브라우저에서 돌리는 것 자체가 또 하나의 shim 과제다.
- **측정 없이 착수하지 말 것**: 먼저 C의 5.74s를 프로파일해 **얼마가 resolve이고 얼마가 트리 쓰기인지** 갈라야 한다. resolve 비중이 작으면 이 작업의 상한도 낮다.

**판정**: 지금 착수할 일은 아니다. §5 캐시가 이미 실익(1.98×)을 냈고, C→B 간극을 메우는 이 작업은 "npm 해석 재현"이라는 큰 비용을 진다. 다만 **캐시에서 더 짜내야 할 때의 다음 수**로 기록해 둔다.

---

## 10. 중간 결론

출발 질문은 "브라우저에서 가상 fs를 어떻게 구현할까"였다. 실제로 답이 나온 건 그 질문이 아니라 **그 아래 깔려 있던 질문**이다: wc-exe가 무엇을 소유해야 하고, 무엇을 남에게 맡겨야 하는가.

### 확정된 것 (근거 있음)

1. **저장 계층은 우리가 소유한다 — 완료.** OPFS 스냅샷 캐시로 install이 11.66s → **0.30s**(캐시 히트 시 전면 스킵). lockfile이 바뀌어도 타르볼 cacache가 살아남아 11.35s → **5.74s**(1.98×). 두 캐시 축(lockfile별 스냅샷 / 전역 누적 타르볼)의 분리가 부분 무효화를 가능하게 한 핵심이다(§5).
2. **실행 계층은 WebContainer를 유지한다 — 성능으로 판정됨.** container2wasm은 빌드 버스트에서 **35× 느리다**(1.6s → 56s). CPU 에뮬레이션 세금이 wc-exe가 없애려던 I/O 병목보다 크다(§7).
3. **WebContainer에서 "얇은 레이어만 떼오기"는 불가능하다.** 공개된 건 껍데기(`webcontainer-core`는 이슈 트래커, `@webcontainer/api`는 폐쇄 런타임의 스텁)이고, 탐내는 fs/런타임 알맹이가 정확히 닫힌 부분이다(§6).
4. **`node:fs`는 필요조건이지 충분조건이 아니다.** npm install을 분해하면 1~4단계(resolve·다운로드·해제·hoist)는 가상 fs로 도달하지만 **5단계 lifecycle scripts(`child_process`)가 벽**이다. 이건 파일시스템 문제가 아니라 프로세스 모델 문제라, fs를 완벽히 가상화해도 열리지 않는다. almostnode가 이걸 동작하는 코드로 실증한다 — 1~4는 되고 `execSync`/`spawnSync`는 throw한다(§9).
5. **결합도는 낮춰뒀다 — 단, WebContainer류 백엔드에 한해서.** 러너가 `Runtime`/`SnapshotProvider` 인터페이스 뒤로 격리돼, 백엔드 교체가 구현 하나 추가로 끝난다(§5 중기). 다만 그 인터페이스는 의도적으로 WebContainer 모양이다 — `spawn`이 pty를 반환하고 `fs`·`workdir`·`path`가 있다. **프로세스 모델을 전제한다는 뜻**이라, container2wasm(진짜 `spawn`이 있다)은 맞지만 번들러 인터셉트는 맞지 않는다(아래 «이음새의 고도»).
6. **인터셉트를 승격한다면 memfs 변형이어야 한다 — 실측으로 갈렸다.** 플러그인 훅으로 VFS를 먹이는 방식(수제 리졸버)은 레거시 `browser` 필드 두 형태에서 **조용히 node 파일을 고르고**, `imports` 필드(`#internal`)에선 external로 흘려 런타임에 깨진다. 네이티브 `vite build`를 기준으로 대조했으니 취향이 아니라 버그다. `--vfs=memfs`(rolldown 자체 리졸버)는 넷 다 통과한다. 대가는 React에서 **약 9%**다 — 처음엔 지연 VFS를 잃어 1.8×로 보였는데, 동기 XHR fault-in으로 되찾았다(§9).
7. **폐쇄성의 비용이 한 번 실제로 청구됐다.** PoC를 돌린 리눅스 샌드박스에서 **WebContainer는 부팅하지 못했고**(런타임 호스트가 차단됨) 인터셉트는 돌았다. 지금까지 이건 "둘을 나란히 비교할 수 없다"는 불편함으로만 기록돼 있었는데, 사실은 **StackBlitz 원격 인프라 의존이 실행 자체를 막은 관측**이다 — §1이 이유로 적어둔 항목이 실제로 일어난 것이다.

### 탐색 도중 나타난 제3의 길

시작할 때의 프레이밍은 "저장소 vs 실행 엔진"이었고, WebContainer를 벗어나려면 **실행 엔진을 재구현해야 한다**는 결론으로 향했다. 그런데 PoC가 세 번째 선택지를 보여줬다:

> **빌드 도구를 실행하지 말고, 우리가 빌드 도구가 된다.**

번들러 인터셉트(`rolldown`→`@rolldown/browser` + lightningcss-wasm)로 브라우저에서 **동작하는 프로덕션 `dist/`가 나온다.** "Node를 에뮬레이트하는" 문제가 "vite의 파이프라인을 재구현하는" 문제로 바뀌고, 후자가 훨씬 작다 — 그리고 빠르다. vite 5의 `dist/node`가 node 빌트인 24개와 `execSync`를 요구하는데, 인터셉트는 그 24개가 전부 불필요하다.

여기까지 실제로 확인한 것: 프로덕션 빌드 동작(런타임 검증 포함), CSS·lazy 청크가 네이티브 vite와 **바이트 동일**, React(실제 의존성·CJS interop·`exports` 맵) 통과, 동적 청킹, lightningcss, `__wcPreload`로 워터폴 제거(~1.9×), 그리고 그 과정에서 **캐시 오염 버그 발견·수정**.

**단, "React 통과"는 나중에 읽던 것보다 좁은 주장으로 판명됐다.** 전용 픽스처(`sample-exports-app`)를 쓰고 나서야 수제 리졸버가 레거시 `browser` 필드와 `imports` 필드를 아예 구현하지 않았다는 게 드러났다 — React가 그 둘을 안 써서 안 걸렸을 뿐이다. 같은 픽스처가 의존성 스캔이 `node_modules/**/dist/`를 통째로 버리던 버그도 잡았는데, 이것도 React 패키지들이 `cjs/`·`umd/`에서 배포해서 안 걸렸던 것이다. **한 픽스처가 통과한다는 건 그 픽스처가 쓰는 형태만 통과한다는 뜻이다**(확정 6, §9).

### 그 길의 진짜 경계 (여기가 중요하다)

**PoC는 vite가 아니다. `vite.config.ts`를 읽지 않는다.** React 픽스처엔 `plugins: [react()]`가 있는데 우리 빌드는 그걸 **통째로 무시**했다. 그런데도 성공한 이유는 평범한 React 앱이 필요로 하는 게 JSX 변환뿐이고 그건 우리가 직접 했기 때문이다. 즉:

> **"React가 된다"는 "JSX 변환만 필요한 React 앱이 된다"는 뜻이다.**

wc-exe의 약속은 "**임의의** 프로젝트를 빌드"인데, "임의"가 사는 곳이 바로 플러그인 생태계다 — Vue SFC, Svelte, MDX, tailwind 플러그인, legacy 타겟, `publicDir`, multi-page. 그건 하나도 손대지 않았다. 그래서 인터셉트는 **현재로선 "빠르고 오픈이지만 좁은" 경로**이고, 넓히는 비용이 이 접근의 미래를 좌우한다.

**그리고 경계 이전에 구멍이 하나 있다.** 위 두 경계는 "빌드가 무엇을 못 하나"인데, 그보다 앞서 **인터셉트는 `npm install`을 하지 않는다.** 디스크에 이미 있는 `node_modules`를 읽는다 — 즉 wc-exe가 없애려던 그 작업을 사용자가 먼저 해야 한다. 대체하는 조각도 가장 작다(부팅 5.4s + install 0.30s + 빌드 1.6s 중 빌드만). 다만 실측해보면 그 벽이 낮을 수 있다는 신호가 있다(§9 《install 없는 인터셉트》): React 픽스처 71개 패키지 중 인터셉트 빌드에 걸리는 lifecycle 훅은 **0개**이고, 필요한 런타임 클로저는 **5개·5MB**다.

**경계가 하나 더 있다 — 범위가 아니라 정확성 쪽이다.** 위 경계는 "못 하는 게 있다"는 정직한 한계지만, 수제 리졸버의 문제는 **틀리게 성공한다**는 것이다. `browser` 필드를 쓰는 패키지를 만나면 빌드는 되고 앱은 렌더되는데 의존성의 Node 빌드가 조용히 브라우저 번들에 링크된다(확정 6). 그래서 이제 "인터셉트"라고 말할 때 **두 변형을 구분해야 한다** — 플러그인 VFS는 이 부류를 계속 만들고, memfs VFS는 그 책임을 rolldown에 넘긴다.

### 이음새의 고도 — 저수준으로 가려면 층을 하나 더 얹어야 한다

인터셉트를 "PoC"에서 "선택 가능한 백엔드"로 올리려 할 때 실제로 걸리는 건 성능도 범용성도 아니라 **이음새가 그어진 높이**다.

`src/runner/src/runtime/runtime.types.ts`는 WebContainer 모양으로 그려져 있고 그건 의도된 선택이다 — 남이 이미 아는 모양이 만족시키기 쉽고, 어댑터가 순수 pass-through로 남는다. 그런데 **번들러 인터셉트에는 프로세스가 없다.** `spawn('npm', ['run', 'build'])`를 구현하려면 명령어 문자열을 패턴 매칭해 흉내내야 하는데, 그건 같은 파일이 경고하는 바로 그것이다 — _"the adapter cannot quietly acquire behaviour of its own"_.

그러니 필요한 건 `Runtime`을 넓히는 게 아니라 그 **위에 얇은 층을 하나 더 얹는 것**이다. "명령을 실행한다"가 아니라 "**프로젝트에서 `dist/`를 만든다**":

```
Builder { build(project, options) → dist }
  ├─ WebContainerBuilder → Runtime.spawn('npm', ['run', 'build'])
  └─ InterceptBuilder    → 브라우저에서 rolldown 직접 구동 (spawn 없음)
```

`Runtime`은 그대로 두고 `Builder`가 그 위에 선다. 이게 없으면 인터셉트는 영원히 PoC로 남는다. 다만 **아래 미결 1의 측정에는 이 층이 필요 없다** — 둘을 그냥 나란히 돌리면 된다. 순서가 뒤바뀌면 안 되는 이유다.

### 지금의 권고

- **프로덕션 경로는 바꾸지 않는다.** WebContainer + OPFS/타르볼 캐시가 현재 최적이고, 이미 실측으로 실익이 증명됐다.
- **인터셉트는 PoC로 유지한다.** 성능·개방성(CDN 불필요)은 매력적이지만 범용성이 아직 약속을 못 지킨다. WebContainer 독점 의존이 실제로 발목을 잡거나, 대상 프로젝트군이 "vite + JSX" 정도로 좁게 수렴하면 그때 승격 후보다. **승격한다면 `--vfs=memfs` 변형이다**(확정 6).
- ~~**rollup 경로**~~ — **걷어냈다.** 아래 «rolldown 단일화» 참조.
- **container2wasm은 성능이 아니라 다른 동인(네이티브 애드온·비-JS 툴체인)이 생길 때만 재검토한다.**
- **vite를 포크하지 않는다.** vrowzer가 포팅 비용을 실측으로 보여줬다 — 25k~28k줄 + vite 버전 고정 + upstream 영구 추적, 그러고도 프로덕션 `dist/`는 아직 안 나온다(§9). 브라우저에서 도는 `vite build`는 upstream vite가 낼 것이고, 그때 공짜로 받는다.

### 남은 미결

0. **부팅 상주화(persistent runner)** — 캐시가 install을 0.30s로 줄인 뒤 **부팅 ~5.4s가 지배적 비용**(warm 실행의 ~70%)이 됐다. 엔진 교체보다 훨씬 싸게 남은 가장 큰 덩어리를 건드린다. 설계: `docs/persistent-runner.md`.
1. **한 머신에서 WebContainer `npm run build` vs 인터셉트 비교** — 큰 미측정 하나. 이 저장소의 벤치 수치는 macOS, PoC 수치는 Linux 컨테이너에서 잰 것이라 직접 비교가 불가하고, WebContainer는 샌드박스에서 부팅되지 않는다.

   **단, 지금 그대로 재면 사과와 오렌지를 비교하게 된다.** 미결 8이 남아 있는 한 인터셉트는 `npm install`을 하지 않으므로(§9), 측정되는 건 "**설치가 끝난 상태에서의 빌드 시간**"뿐이다. 그건 WebContainer 경로 warm 실행 비용의 약 1/5다(부팅 5.4s + install 0.30s + 빌드 1.6s 중 빌드만). 그러니 둘 중 하나를 해야 한다:
   - **범위를 명시한다** — "빌드 단계만"이라고 못 박고, 부팅·install은 비교에서 제외한다고 결과에 적는다. 그러면 이 숫자는 "인터셉트를 승격할 가치가 있나"가 아니라 "번들러 자체가 더 빠른가"만 답한다.
   - **인터셉트 쪽에 install 비용을 얹는다** — 미결 8이 되고 나서 재면 비로소 같은 일을 하는 두 경로의 비교가 된다.

   전자가 지금 가능한 것이고, 후자가 실제로 결정을 내려주는 것이다. **"이 탐색의 마지막 숫자"였던 지위는 미결 8에게 넘어갔다.**

2. 플러그인 호환성 — 위에서 말한 경계. 무엇을 얼마나 지원할지가 곧 범위 결정이다.
3. 미검증 생태계 형태 — **일부 해소.** `browser` 필드 remap·`imports` 필드·깊은 `exports` 와일드카드는 `sample-exports-app`으로 검증했고(네이티브 vite 기준 대조), **`--vfs=memfs`만 전부 통과한다**(§9). 남은 것: worker/wasm import, CSS `@import`/`url()` 애셋 참조, sourcemap, multi-page.
4. 캐시 고도화(§5): cacache blob 무한 증가는 상한으로 막았지만, lockfile diff 기반 부분 무효화(burrow `src/npm`의 stale-lock retry가 원형)는 아직 안 했다.
5. **`Builder` 이음새** — 인터셉트를 두 번째 백엔드로 올리려면 `Runtime` 위에 "프로젝트 → `dist/`" 층이 필요하다(위 «이음새의 고도»). 1의 측정이 유리하게 나온 **뒤에** 긋는다.
6. ~~**fs-proxy memfs 이식 실험**~~ — **완료(`--vfs=memfs`).** 동작하고 출력이 바이트 동일하며, 지연 VFS도 **되찾았다**(동기 XHR fault-in) — 대가가 1.8×에서 약 9%로 내려갔고 규모가 큰 앱에선 eager 대비 4×다. 미결 3의 해당 형태들은 이 모드에서만 올바로 해석된다(위 3 참조). vrowzer의 10MB 페이로드 패치는 **필요 없었다**. §9 참조.
7. **OXC `vite.config.ts` 정적 추출**(§9 vrowzer) — 미결 2를 포크 없이 좁히는 저비용 수단. 못 다루는 설정을 `unsupported[]`로 신고하는 부분이 특히 우리 취향이다.
8. **install 없는 인터셉트** — 인터셉트가 wc-exe의 실제 문제를 풀려면 반드시 필요하다(§9). **①단계 완료: 10개 프로젝트 실측에서 런타임 클로저의 lifecycle 훅은 0개다**(`bench/install-shape.mjs`). 전송량 우려도 lazy fault-in이 대부분 없앴다 — 그래프가 실제로 읽는 건 클로저의 1~2%다. 남은 것: ② 호스트가 lockfile → 타르볼 → 메모리 → 볼륨을 잇는다. **타르볼 단위 지연 페치**가 자연스러운 모양이다. **npm 트리 해석을 재현해야 하는 부분이 비용의 본체**라는 «하이브리드 착지점»의 경고가 그대로 적용된다.

### 이 탐색에서 배운 방법론

수치를 믿기 전에 **교차 측정**하고, 통과를 믿기 전에 **검사가 실패하는지** 확인해야 했다. 실제로 그 과정에서 잡은 것들: 스냅샷 HIT이 빈 디렉터리를 HIT으로 보고하던 기존 버그, 게스트 클럭 스큐, lightningcss가 번들 버스트를 두 배로 만드는 비용, react-dom의 CSS 속성명 목록이 만든 오탐, oxc의 백틱 리터럴, 해시 정합성 캐시 오염, 의존성 스캔이 `node_modules/**/dist/`를 통째로 버리던 버그, 그리고 런타임 검사가 죽으면서 static 결과를 통째로 가리던 하네스 결함. **문서에 적힌 수치 중 처음 측정에서 그대로 살아남은 게 거의 없다.**

여기에 세 가지가 더해졌다. 셋 다 **전제**에 관한 것이고, 셋 다 측정 없이 넘어갔으면 잘못된 설계가 굳었을 것들이다.

**① 남의 코드에서 베낀 전제도 재야 한다.** vrowzer의 fs-proxy 페이로드 10KB → 10MB 확장은 논리가 빈틈없어 보였고(react-dom 130KB를 10KB 버퍼로 못 받는다) 그대로 이식했는데, 재보니 **stock 10KB에서도, 1KB에서도 빌드된다.** 모듈 내용이 그 경로로 안 다니기 때문이다. 검증 없이 이식했으면 의존성 소스 패치를 영구히 지고 갈 뻔했다.

**② "통과"는 픽스처가 시험하는 형태에 대해서만 참이다.** React 픽스처가 오래 통과하는 동안 수제 리졸버는 `browser` 필드와 `imports` 필드를 아예 구현하지 않은 상태였고, 하네스는 `node_modules/**/dist/`를 통째로 버리고 있었다. 둘 다 **그걸 찾으러 간 픽스처를 쓰고 나서야** 나왔다. 새 형태를 지원한다고 말하기 전에 그 형태만 보는 픽스처를 먼저 쓰고, **기준(native `vite build`)과 대조**해야 한다.

**③ 스스로 세운 제약도 재야 한다 — 이게 제일 비쌌다.** "번들러의 fs 호출이 동기라 lazy fetch가 불가능하다"는 남에게서 베낀 것도, 문서에서 읽은 것도 아니다. `--vfs=memfs`를 설계하면서 **우리가 추론한 것**이고, 그 위에 `/api/bulk`(전면 전송)와 콘텐츠 필터가 세워졌고, "memfs 모드는 React에서 1.8×를 문다"는 판정과 "install 없는 인터셉트의 비용은 전송량"이라는 결론까지 그 위에 얹혔다.

틀렸다. `fetch`가 비동기인 것과 **페이지가 동기 요청을 못 하는 것**은 다른 얘기고, 동기 XHR은 그대로 동작한다. 그게 나쁜 관행인 이유(메인 스레드 블로킹)는 **UI가 없는 헤드리스 러너에는 해당되지 않는다** — 즉 제약이 아니라 **다른 맥락의 관행을 그대로 가져온 것**이었다. 실제로 재보니 3ms였고, 페널티가 1.8× → 9%로, 큰 앱에선 eager 대비 4×로 내려갔다.

패턴이 보인다. ①은 남의 전제, ②는 우리 증거의 범위, ③은 **우리 자신의 추론**이다. 그리고 셋 중 ③이 가장 오래 살아남았는데, 이유가 명확하다 — **①은 출처가 있어서 의심할 대상이고 ②는 반례를 찾으러 갈 수 있는데, ③은 우리가 쓴 문장이라 근거처럼 읽힌다.** 설계 결정의 근거가 "재봤다"가 아니라 "그럴 것이다"이면, 문서에 그렇게 적어야 한다.

부수적으로 배운 것 하나: ③을 깬 실험은 **훅 지점을 추측하지 않고 계측한 것**이었다. rolldown이 `readFileSync`를 쓸 거라 짐작했는데 실제로는 디스크립터 API였고, 그걸 확인하는 데 든 비용은 스파이크 한 번이었다.

---

## 참고

- [container2wasm](https://github.com/container2wasm/container2wasm) — 컨테이너 → wasm 변환기 (NTT, ktock)
- [vscode-container-wasm](https://github.com/ktock/vscode-container-wasm) — container2wasm을 VS Code for the Web에서 실행하는 확장 (실전 레퍼런스)
- [qemu-wasm](https://github.com/ktock/qemu-wasm) / [브라우저 데모](https://ktock.github.io/qemu-wasm-demo/)
- [container2wasm 데모](https://ktock.github.io/container2wasm-demo/)
- ["Running QEMU Inside Browser" (FOSDEM 2025)](https://archive.fosdem.org/2025/events/attachments/fosdem-2025-6290-running-qemu-inside-browser/slides/238760/slides_1dDtpcS.pdf)
- [burrow](https://github.com/dhravya/burrow) — 오픈소스(MIT) WebContainer 대안: 네이티브 JS 엔진 + 주변 가상화 (§8)
- [almostnode](https://github.com/macaly/almostnode) — 오픈소스(MIT) 브라우저 Node: 진짜 npm install + 번들러 인터셉트, dev 중심 (§9)
- [vrowzer](https://github.com/kazupon/vrowzer) — 오픈소스(MIT) 브라우저 vite dev server: 진짜 vite 포크(~40k줄), dev 전용·빌드 미연결, `@rolldown/browser`에 memfs를 물리는 fs-proxy 구현 (§9)
- [ZenFS](https://github.com/zen-fs/core) (구 [BrowserFS](https://github.com/jvilk/BrowserFS)) — 플러그블 백엔드 VFS
- [v86](https://github.com/copy/v86) — x86 브라우저 에뮬레이터
- [OPFS 설명](https://renderlog.in/blog/origin-private-file-system-opfs/)
