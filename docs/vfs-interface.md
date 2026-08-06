# Runtime / VFS 인터페이스 — 백엔드 교체 여지 확보

> 목적: 러너 로직을 특정 실행 엔진(WebContainer)이 아니라 **인터페이스**에 대고 쓰게 만들어, 나중에 다른 백엔드(container2wasm, 순수 wasm 도구, 테스트용 mock)를 **러너 로직 수정 없이** 끼울 수 있게 한다. 성능 결론([[docs/virtual-filesystem.md]] §7)과 무관한 순수 구조 개선이다.

## 배경 — 결합은 한 파일에 몰려 있었다

`src/runner/src/main.ts`가 `webcontainer.*`를 직접 부르는 유일한 곳이었다: `boot`/`mount`/`spawn`/`fs.readFile·writeFile·readdir`/`export`/`on('server-ready')`. 호스트층(`src/core/browser.ts`의 `WCBrowser`)은 이미 `window.wcRunner.X()`만 부르는 RPC 프록시라 WebContainer에 직접 묶여있지 않았다. 그래서 추출 비용이 작다.

## 설계

`src/runner/src/runtime/`:

- **`runtime.types.ts`** — 백엔드가 구현할 최소 표면.
  - `Runtime`: `boot / fs / workdir / path / mount / spawn / onServerReady / teardown`
  - `RuntimeFileSystem`: `readFile / writeFile / readdir / mkdir / rm / rename`
  - `SnapshotProvider`(선택): `exportDir(path) / importSnapshot(bytes, mountPoint)`
  - `isSnapshotCapable(runtime)` 타입 가드
  - `FileTree` / `RuntimeProcess` / `RuntimeDirEnt` / `SpawnOptions` / `TerminalSize` — WebContainer 타입 이름이 러너 로직으로 새지 않도록 구조적으로 동일한 자체 타입
- **`webcontainer-runtime.ts`** — `WebContainerRuntime implements Runtime, SnapshotProvider`. **WebContainer를 import하는 유일한 파일.** 대부분 얇은 passthrough(`WebContainerProcess`/`DirEnt`가 구조적으로 `RuntimeProcess`/`RuntimeDirEnt`를 만족).

`main.ts`는 `let runtime: Runtime`만 들고 `runtime.X()`를 부른다. WebContainer라는 단어가 이 파일에서 사라졌다.

## 핵심 결정 — 스냅샷은 "전용 capability"다

OPFS `node_modules` 캐시는 `export('node_modules','binary')` + `mount(snapshot)`에 의존하는데, 이건 **WebContainer 독점 스냅샷 포맷**이다. container2wasm 등 다른 백엔드엔 대응물이 없다(게스트 디스크 이미지나 tar 등 방식이 다름).

그래서 스냅샷을 `Runtime` 본체가 아니라 **선택적 `SnapshotProvider`** 로 분리했다:

- 캐시 오케스트레이션(lockfile 해시 키 → OPFS 조회 → 없으면 install 후 저장)은 백엔드 무관하게 유지.
- `installWithCache`는 `isSnapshotCapable(runtime)`로 감지: 스냅샷 가능하면 캐시 경로, 아니면 **plain install로 우아하게 degrade**.

이 분리를 놓치면 "모든 백엔드가 export/mount를 가진다"고 잘못 가정하게 된다.

## 새 백엔드를 추가하려면

1. `class Container2WasmRuntime implements Runtime` 작성 (스냅샷 방식이 있으면 `SnapshotProvider`도).
2. `main.ts`의 `boot()`에서 어떤 구현체를 쓸지 고르는 한 줄만 교체(또는 런타임 선택 로직 추가).
3. 러너의 `mountFromServer`/`installWithCache`/`uploadDist`/`runCommand`는 **한 줄도 안 바뀐다.**

## 표면이 넓어진 이유 (2026-08 갱신)

최초 표면은 7개였다. 지금은 더 넓은데, **추가된 것마다 그것 없이 못 고친 버그가 하나씩 있다.** 넓힌 게 아니라 부족했던 것이 드러난 것에 가깝다.

| 추가                                                       | 왜                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fs.rm`                                                    | `mount`는 추가·덮어쓰기만 한다. 호스트에서 지운 파일이 컨테이너에 남아 **없는 소스로 빌드가 성공**했다([[docs/persistent-runner.md]] §6) |
| `fs.mkdir`                                                 | 패키지 매니저가 쓸 설정 디렉터리를 만들어야 했다(§16.2)                                                                                  |
| `fs.rename`                                                | `wc.fs`에 있는데 우리에게만 없었다. 형태를 맞추는 편이 낫다                                                                              |
| `workdir`                                                  | 도구에 절대 경로를 넘겨야 하는 곳이 있다                                                                                                 |
| `path`                                                     | **백엔드가 무엇을 실행할 수 있는지 알아낼 유일한 방법.** 파일시스템으로는 `PATH`의 디렉터리가 안 보인다(§2.2)                            |
| `teardown`                                                 | §6의 리셋 트리거가 요구한다. **아직 소비자는 없다**                                                                                      |
| `SpawnOptions`, `RuntimeProcess`의 `input`/`kill`/`resize` | 종료 코드만 통과시키느라 취소·대화형 입력·터미널 크기를 전부 버리고 있었다([[docs/persistent-runner.md]] §4)                             |

`fs`를 네임스페이스로 묶고 이름을 `wc.*`에 맞춘 것도 같은 이유다 — 교체 백엔드가 만족시킬 계약이라면, **이미 아는 형태**가 여기서 발명한 형태보다 만족시키기 쉽다. 부수 효과로 `WebContainerRuntime`이 거의 순수 위임으로 유지되는데, 어댑터가 자기 로직을 가지면 나중에 다시 구현해야 할 대상이 인터페이스가 아니라 그 어댑터가 되기 때문에 이게 중요하다.

의도적으로 `wc.*`와 다른 곳은 인터페이스 안 각 멤버에 이유를 적어뒀다(`readdir`은 항상 타입 반환, `on(event,…)`은 `onServerReady`로 좁힘).

## 검증 (무동작변경)

- `pnpm typecheck` / `pnpm lint` / `pnpm build` 통과.
- 러너 직접 타입체크(`tsc --lib ES2022,DOM …`) 통과 — vite/esbuild는 타입을 안 보므로 별도 확인.
- `--cache` cold/warm e2e가 리팩터 전과 동일: cold MISS→install→20.2MB, warm HIT→restore. 캐시 키·스냅샷 크기 불변.

## 범위 밖

- 새 백엔드 구현 없음(인터페이스 + WebContainer 구현체 1개만).
- 호스트층 `WCBrowser` 대공사 없음(이미 RPC 프록시).

## 지금 이 인터페이스의 위치 (2026-08)

WebContainer를 계속 쓸지가 열린 질문이 됐다([[docs/persistent-runner.md]] §16). 그 상황에서 이 인터페이스는 **보험**이다 — 백엔드를 바꾸더라도 러너 로직은 계약에 대고 쓰여 있다.

다만 정직하게: 아직 **구현체는 하나뿐이고, 두 번째로 유력한 후보가 없다.** container2wasm은 35× 벽이고([[docs/virtual-filesystem.md]] §7), 더 유망해 보이는 방향(호스트-사이드 의존성 해석)은 `Runtime`을 구현하는 게 아니라 아예 다른 층이라 이 인터페이스와 나란히 간다. **구현체가 둘이 되기 전까지 이 추상화가 실제로 맞는지는 증명되지 않은 상태**로 남는다.
