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

아래로 갈수록 "진짜 컴퓨터에 가까워지고" 무거워진다. wc-exe에 필요한 건 *어느 층까지 내려가야 하는가* 의 판단이다.

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

**진짜 CPU + 진짜 리눅스 커널을 브라우저에서 에뮬레이트**하고, 그 안에서 평범한 `node`/`npm`을 돌린다. 파일시스템은 게스트 리눅스의 진짜 ext4/9p이고, 브라우저는 그 디스크 이미지를 메모리(또는 OPFS)에 들고 있을 뿐이다. → **"가상 fs"를 가장 근본적으로 구현하는 방법.** 파일시스템을 흉내 내는 게 아니라 *실제 커널의 fs를 그대로 쓴다.*

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

| 접근 | 범용 빌드 | 호스트 디스크 쓰기 | 무게 | 성숙도 | WebContainer 탈피 |
|---|---|---|---|---|---|
| A. memfs/ZenFS | ❌ 실행 불가 | 없음 | 매우 가벼움 | 높음 | 부분(캐시용) |
| B. WebContainer (현행) | ✅ | 없음 | 중간 | 높음 | — |
| C. wasm 도구 + WASI fs | △ 고정 파이프라인만 | 없음 | 가벼움 | 중간 | 부분 |
| D. QEMU-wasm/container2wasm | ✅✅ (진짜 리눅스) | 없음 | 무거움 | 실험적·발전중 | 완전 |

---

## 5. 현실적인 로드맵 제안

축을 나눠서 접근하는 걸 권한다. **"WebContainer를 당장 갈아엎기"가 아니라 "VFS 축을 우리가 통제하기"** 부터.

**단기 — 현행 유지 + 영속 캐시 계층 도입 (계층 A 활용)**
지금 가장 큰 불편은 매 실행마다 `npm install`을 처음부터 하는 것. `node_modules`를 **OPFS/IndexedDB에 스냅샷**해두고 재사용하면 체감이 크게 는다. 이미 `install --cache` 플래그 자리가 있다. ZenFS의 OPFS 백엔드나 OPFS 직접 접근으로, WebContainer 마운트 전에 캐시를 복원 → 빌드 후 갱신. **WebContainer는 그대로 두고 그 아래 저장 계층만 우리가 소유.**

**중기 — 자체 VFS 추상화로 결합도 낮추기**
`src/runner`가 지금은 WebContainer API에 직접 묶여 있다 (`webcontainer.mount`, `wc.fs.*`, `spawn`). 이걸 얇은 **VFS/Runtime 인터페이스**(`mount`, `readFile`, `writeFile`, `readdir`, `spawn`) 뒤로 숨겨두면, 나중에 백엔드를 WebContainer ↔ container2wasm ↔ 순수 wasm 도구로 교체하기 쉬워진다. 지금 하면 비용이 작고 나중에 자유도가 커진다.

**장기 — container2wasm PoC로 WebContainer 독립성 검증**
독점 의존과 Node 환경 제약이 실제로 발목을 잡는 시점이 오면, container2wasm `--to-js`로 "node 이미지 + 샘플 vite 앱 빌드"를 브라우저에서 돌려 **실측**(부팅 시간, install 시간, build 시간)한다. 네트워킹은 기존 Hono 서버에 npm 레지스트리 WebSocket 프록시를 붙여 해결. 성능이 감당되면 진짜 리눅스라 범용성/네이티브 애드온 문제가 근본적으로 풀린다.

### 핵심 판단

- 사용자의 직관(QEMU-wasm) 은 **기술적으로 옳고 이미 구현체가 있다** (container2wasm). "가상 fs"를 가장 근본적으로 푸는 길이다.
- 다만 wc-exe의 원래 목적은 *I/O 병목 제거*였는데, 전체 에뮬레이션은 *CPU 병목*을 새로 들여온다. 그래서 "무조건 QEMU"가 아니라, **저장 계층(VFS)은 지금부터 우리가 소유하고(OPFS 캐시), 실행 계층은 WebContainer를 유지하되 인터페이스로 격리해 두었다가, container2wasm이 성능적으로 익으면 갈아끼우는** 단계적 경로가 가장 합리적이다.

---

## 참고

- [container2wasm](https://github.com/container2wasm/container2wasm) — 컨테이너 → wasm 변환기 (NTT, ktock)
- [qemu-wasm](https://github.com/ktock/qemu-wasm) / [브라우저 데모](https://ktock.github.io/qemu-wasm-demo/)
- [container2wasm 데모](https://ktock.github.io/container2wasm-demo/)
- ["Running QEMU Inside Browser" (FOSDEM 2025)](https://archive.fosdem.org/2025/events/attachments/fosdem-2025-6290-running-qemu-inside-browser/slides/238760/slides_1dDtpcS.pdf)
- [ZenFS](https://github.com/zen-fs/core) (구 [BrowserFS](https://github.com/jvilk/BrowserFS)) — 플러그블 백엔드 VFS
- [v86](https://github.com/copy/v86) — x86 브라우저 에뮬레이터
- [OPFS 설명](https://renderlog.in/blog/origin-private-file-system-opfs/)
