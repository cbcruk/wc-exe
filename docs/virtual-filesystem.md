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

### 계층 D — 전체 시스템 에뮬레이션 (질문의 QEMU 방향)

**진짜 CPU + 진짜 리눅스 커널을 브라우저에서 에뮬레이트**하고, 그 안에서 평범한 `node`/`npm`을 돌린다. 파일시스템은 게스트 리눅스의 진짜 ext4/9p이고, 브라우저는 그 디스크 이미지를 메모리(또는 OPFS)에 들고 있을 뿐이다. → **"가상 fs"를 가장 근본적으로 구현하는 방법.** 파일시스템을 흉내 내는 게 아니라 _실제 커널의 fs를 그대로 쓴다._

대표 프로젝트:

- **[v86](https://github.com/copy/v86)** — x86을 JS/wasm으로. 가볍지만 32비트, 성능 제약.
- **[qemu-wasm](https://github.com/ktock/qemu-wasm)** (ktock, NTT) — QEMU를 브라우저로 포팅, **TCG(JIT) 켜짐**. aarch64/x86_64 게스트.
- **[container2wasm](https://github.com/container2wasm/container2wasm)** — OCI 컨테이너 이미지를 wasm으로 변환. `--to-js`로 브라우저에서 **컨테이너를 그대로 실행**. 내부적으로 QEMU-wasm(또는 Bochs/TinyEMU)이 CPU를 에뮬레이트하고 그 위에서 `runc`가 컨테이너를 띄운다. 2025년 FOSDEM에서 발표된, 이 분야에서 가장 성숙한 결과물.

이게 사용자가 감을 잡은 그 방향이 맞다. "QEMU를 wasm으로 돌릴 수 있다 → 그 안에 리눅스 → 그 안에 node → 파일은 전부 게스트 안(=브라우저 메모리)에만" 이라는 논리는 정확히 성립하고, 이미 동작하는 데모까지 있다.

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

| 접근                        | 범용 빌드            | 호스트 디스크 쓰기 | 무게        | 성숙도        | WebContainer 탈피  |
| --------------------------- | -------------------- | ------------------ | ----------- | ------------- | ------------------ |
| A. memfs/ZenFS              | ❌ 실행 불가         | 없음               | 매우 가벼움 | 높음          | 부분(캐시용)       |
| B. WebContainer (현행)      | ✅                   | 없음               | 중간        | 높음          | —                  |
| B'. burrow (§8)             | △ 자체 런타임 의미론 | 없음               | 중간        | 초기          | 완전(단, 범용성 ↓) |
| C. wasm 도구 + WASI fs      | △ 고정 파이프라인만  | 없음               | 가벼움      | 중간          | 부분               |
| D. QEMU-wasm/container2wasm | ✅✅ (진짜 리눅스)   | 없음               | 무거움      | 실험적·발전중 | 완전               |

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
- 정직한 한계 2 — 2× 는 좋지만 **B의 0.3s에는 한참 못 미친다**. 타르볼 캐시는 네트워크만 없애고 npm의 해석·node_modules 재구성은 그대로 하기 때문. lockfile이 거의 안 바뀌는 프로젝트라면 이득이 드물게만 발생한다.
- `--prefer-offline`이라 캐시에 없으면 조용히 네트워크로 degrade(견고).
- 재현: `node bench/cache-scenarios.mjs` (격리된 임시 캐시 디렉터리·프로파일 사용, 실제 `~/.cache/wc-exe`는 건드리지 않음).

### 캐시 축출 (용량 상한) ✅ **구현됨**

두 캐시 모두 무한 증가하므로 성격에 맞게 다르게 상한을 건다.

- **`nm-*.bin` 스냅샷 → LRU 바이트 예산** (`MAX_SNAPSHOT_BYTES`, 기본 512MB). lockfile마다 새 blob이 생겨 곱으로 늘어나는 쪽이라 제대로 된 LRU가 필요하다. OPFS엔 쓸만한 access time이 없어 `cache-index.json`에 `lastUsed`를 직접 기록하고, 오래된 것부터 예산 이하가 될 때까지 삭제한다. **이번 실행이 쓴 항목은 축출에서 보호**된다.
- **cacache blob → 하드 캡 후 드롭** (`MAX_CACACHE_BYTES`, 기본 256MB). 단일 blob이라 LRU 개념이 없고, 전부 **재생성 가능**하므로 상한을 넘으면 그냥 지운다. 대가는 다음 install 한 번이 온라인이 되는 것뿐.
- 인덱스는 실제 OPFS 목록을 기준으로 정리해 파일이 사라져도 드리프트하지 않는다.
- **검증**: 상한을 임시로 25MB/50MB로 낮춰 lockfile 3종을 연속 실행 → cacache는 매번 `69 MB over 50 MB cap — dropped` 후 재시딩(`tarballHit=false`), 스냅샷은 매번 직전 것이 `evicted LRU snapshot ...(20.2 MB)`로 축출되고 최신 것만 남아 OPFS가 예산을 넘지 않음을 확인. 운영값 복귀 후 벤치 재실행에서 회귀 없음(C vs D 2.32×).

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

## 참고

- [container2wasm](https://github.com/container2wasm/container2wasm) — 컨테이너 → wasm 변환기 (NTT, ktock)
- [vscode-container-wasm](https://github.com/ktock/vscode-container-wasm) — container2wasm을 VS Code for the Web에서 실행하는 확장 (실전 레퍼런스)
- [qemu-wasm](https://github.com/ktock/qemu-wasm) / [브라우저 데모](https://ktock.github.io/qemu-wasm-demo/)
- [container2wasm 데모](https://ktock.github.io/container2wasm-demo/)
- ["Running QEMU Inside Browser" (FOSDEM 2025)](https://archive.fosdem.org/2025/events/attachments/fosdem-2025-6290-running-qemu-inside-browser/slides/238760/slides_1dDtpcS.pdf)
- [burrow](https://github.com/dhravya/burrow) — 오픈소스(MIT) WebContainer 대안: 네이티브 JS 엔진 + 주변 가상화 (§8)
- [ZenFS](https://github.com/zen-fs/core) (구 [BrowserFS](https://github.com/jvilk/BrowserFS)) — 플러그블 백엔드 VFS
- [v86](https://github.com/copy/v86) — x86 브라우저 에뮬레이터
- [OPFS 설명](https://renderlog.in/blog/origin-private-file-system-opfs/)
