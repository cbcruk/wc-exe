# WebContainer shell probe

**질문: WebContainer는 실제로 얼마나 SSH 같은가?**

`docs/persistent-runner.md`가 그리는 그림은 살아 있는 컨테이너에 셸처럼 붙는 것입니다. `@webcontainer/api`의 타입을 보면 그 재료가 이미 있습니다 — `WebContainerProcess`는 스스로를 "attached pseudoterminal device"라고 부르고 `input` / `output` / `kill()` / `resize()`를 노출합니다.

하지만 **광고된 것과 측정된 것은 다릅니다.** 이 프로브가 그걸 실제로 돌려봅니다.

```bash
pnpm --dir poc/webcontainer-shell-probe install   # 최초 1회
node poc/webcontainer-shell-probe/run.mjs
```

옵션: `--verbose`(페이지 콘솔·HTTP 로그), `--headful`(브라우저 창 띄우기), `--timeout <ms>`.

필요한 것: Chrome/Chromium(`CHROME_PATH`), 그리고 **StackBlitz 런타임 호스트로 나가는 네트워크**. WebContainer는 부팅할 때 자기 런타임을 거기서 받아옵니다.

## 무엇을 재는가

| 그룹        | 확인 항목                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 환경        | 교차 출처 격리 여부, `workdir`, 기본 `PATH`, `fs` API가 시스템 파일시스템을 보는가, **셸로 얻은 전체 바이너리 목록**                                                                                          |
| 셸          | `jsh`/`sh`/`bash`/`zsh`/`ash`/`dash` 중 무엇이 대화형으로 뜨는가                                                                                                                                              |
| 바이너리    | `node`, `npm`, `git`, `curl`, `vi`, `python3`, `gcc` 등이 있는가                                                                                                                                              |
| **PTY**     | stdin으로 친 명령이 실제로 실행되는가 / 입력이 에코되는가 / ANSI 이스케이프가 오는가 / `cd` 상태가 입력 사이에 유지되는가 / **Ctrl-C가 포그라운드만 죽이고 셸은 살아남는가** (갓 띄운 셸과 오래 쓴 셸을 따로) |
| 터미널 제어 | `terminal: {cols,rows}`가 프로세스가 보는 폭에 반영되는가, `resize()`가 실행 중인 프로세스에 resize 이벤트로 도달하는가                                                                                       |
| spawn 옵션  | `cwd`, `env`가 반영되는가, 두 프로세스가 동시에 도는가                                                                                                                                                        |

각 항목은 `pass` / `fail` / `error` / `skip` / `info`, 그리고 `broken`으로 보고됩니다.

## 이 프로브를 왜 믿을 수 있는가

측정 도구가 조용히 초록불을 내는 건 아무것도 안 재는 것보다 나쁩니다. 그래서 두 겹을 넣었습니다.

**1. 프로브 안의 음성 대조군.** 통과가 진짜 통과인지 자기가 검사합니다.

- **한 번도 보내지 않은 마커**(`WCPROBE_NEVER_SENT_MARKER`)가 transcript에 나타나면 → `broken`. 다른 결과 전부를 못 믿는다고 보고합니다.
- **존재할 수 없는 바이너리**를 목록에 섞어 넣습니다. 그게 "있음"으로 분류되면 → `broken`. 있음/없음을 구분하지 못한다는 뜻이니까요.

**2. 가장 위험한 트릭에 단위 테스트.** PTY는 친 것을 그대로 에코합니다. 그래서 `echo WCPROBE_STDIN_OK`라고 치면 **셸이 완전히 멈춰 있어도** 마커가 transcript에 찍혀 검사가 통과합니다. 이걸 피하려고 마커를 따옴표로 쪼갭니다:

```
친 것:       echo "WCPROBE""_STDIN_OK"     → 에코에는 따옴표가 남음
실행 결과:   WCPROBE_STDIN_OK               → 여기서만 마커가 온전해짐
```

즉 매칭은 **에코가 아니라 실행**을 증명합니다. 이 성질을 `pty.test.mjs`가 검사하고, **일부러 깨뜨렸을 때 실제로 실패하는 것까지 확인**했습니다:

| 깨뜨린 것                     | 실패한 테스트                                              |
| ----------------------------- | ---------------------------------------------------------- |
| 마커에서 따옴표 분리 제거     | `stdin: the typed keystrokes do NOT contain the marker`    |
| `CTRL_C`에서 제어 바이트 소실 | `CTRL_C is the single byte a terminal sends for interrupt` |
| `waitFor`의 타임아웃 제거     | `rejects on timeout when the pattern never arrives`        |

제어 바이트(0x03, 0x1b)를 리터럴 대신 `String.fromCharCode()`로 만드는 것도 같은 이유입니다 — 소스 안의 보이지 않는 바이트는 에디터나 복사·붙여넣기가 조용히 먹어버릴 수 있고, 그러면 두 검사가 무조건 통과하는 빈 껍데기가 됩니다.

## 결과 읽는 법

사람이 읽을 요약이 stdout에, 원본 JSON이 `out/report.json`에 남습니다.

- `broken`이 하나라도 있으면 **다른 결과를 읽지 마십시오.** 종료 코드도 1입니다.
- `pty.stdin`이 `fail`이면 상주 셸 그림 자체가 성립하지 않습니다.
- `pty.sigint`가 `fail`이면 붙을 수는 있어도 Ctrl-C가 안 되는 셸이라, 체감이 SSH와 많이 다릅니다.
- `pty.sigint`는 통과하는데 `pty.sigint_aged`만 `fail`이면 셸이 아니라 **세션 수명**의 문제입니다 — 아래 jsh 항목을 보십시오.
- `binaries.probe`의 `absent` 목록이 "리눅스 박스에 SSH"와 "Node 샌드박스에 SSH" 사이 어디쯤인지를 알려줍니다.

## 측정 결과 (macOS, Chrome, `@webcontainer/api` 1.6.4)

**17 pass · 3 info · 1 fail.** 부팅 3.6초.

### 되는 것 — SSH 그림은 성립합니다

| 항목                               | 결과                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `pty.stdin`                        | stdin으로 친 명령이 **실제로 실행됨**                                               |
| `pty.echo` / `pty.ansi`            | 입력 에코됨, ANSI 이스케이프 옴 → 진짜 터미널 에뮬레이터가 필요                     |
| `pty.state`                        | `cd`가 입력 사이에 유지됨 — **일회성 명령의 나열이 아니라 세션**                    |
| `pty.sigint`                       | **Ctrl-C가 포그라운드만 죽이고 셸은 살아남음**                                      |
| `terminal.size` / `resize`         | 100컬럼 요청 → 프로세스가 100으로 봄. `resize()`가 실행 중 프로세스에 이벤트로 도달 |
| `process.kill`                     | 종료 코드 143 (SIGTERM)                                                             |
| `spawn.cwd` / `env` / `concurrent` | 전부 반영됨. 두 프로세스 동시 실행 2.07초(순차라면 ~3초)                            |

셸은 `jsh` 하나입니다. `sh`·`bash`·`zsh`는 `/bin`에서 `@`로 표시되는 **jsh 심볼릭 링크**이고, `ash`·`dash`는 없습니다.

### 안 되는 것

**`env.fs_scope` fail — `fs` API는 시스템 파일시스템을 못 봅니다.** 절대 경로가 workdir 기준으로 해석돼서 `fs.readdir('/bin')`이 `/home/<workdir>/bin`을 찾고 ENOENT가 납니다. 바이너리는 존재하지만 `fs`에는 안 보입니다 — 그래서 이 프로브의 인벤토리는 **셸을 통해** 나갑니다.

**설치된 것 전부 (46개):**

- `/bin` — bash, cat, chmod, cp, echo, hostname, jsh, kill, ln, ls, mkdir, mv, ps, pwd, rm, rmdir, sh, xxd, zsh
- `/usr/bin` — alias, cd, clear, curl, env, false, getconf, head, sort, tail, touch, true, uptime, which
- `/usr/local/bin` — code, google-chrome, jq, loadenv, node, npm, npx, pnpm, pnpx, python3, wasm, xdg-open, yarn

**없는 것: `git`, `grep`, `sed`, `tar`, `wget`, `vi`, `gcc`.** "리눅스 박스에 SSH"가 아니라 **"Node 샌드박스에 SSH"**입니다.

### 설계에 직접 걸리는 발견: jsh는 입력을 몰아 쓰면 깨집니다

앞 명령이 끝나기 전에 다음 명령 줄을 쓰면 jsh가 내부 에러를 던집니다:

```
❯ WCPROBE_CWD_OK
jsh: Cannot read properties of undefined (reading 'exitCode')
❯ node -e '...'
WCPROBE_FOREGROUND_READY        ← 명령은 계속 실행됨
                                 ← 그런데 Ctrl-C가 아무것도 안 함
```

**그 뒤로 셸은 멀쩡해 보이는데 job control만 조용히 죽습니다.** 명령은 돌고 출력도 나오지만 Ctrl-C에 반응할 포그라운드 잡이 없습니다.

A/B로 확인했습니다 — 쓰기를 직렬화(프롬프트를 기다린 뒤 다음 줄)하니 내부 에러가 사라지고 `pty.sigint_aged`가 통과했습니다. 그래서 프로브는 두 경우를 **분리해서** 보고합니다:

- `pty.sigint` — 갓 띄운 셸
- `pty.sigint_aged` — 명령 25개를 이미 처리한 셸

상주 러너는 한 세션을 오래 붙들고 여러 곳에서 쓰게 되므로, **쓰기를 직렬화하고 프롬프트를 기다리는 것이 선택이 아니라 요구사항**입니다. 안 그러면 "빌드는 계속 되는데 Ctrl-C만 안 먹는" 상태로 조용히 넘어갑니다.

### 프로브 자신이 먼저 틀렸던 것들

첫 실행은 두 개를 잘못 보고했고, 그대로 믿었으면 결론이 뒤집혔을 것입니다:

| 처음 보고                              | 실제                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `pty.sigint` 실패 → "Ctrl-C 안 됨"     | Ctrl-C는 **된다.** 0x03 직후 대기 없이 다음 줄을 써서 셸이 못 받은 것                 |
| `binaries.probe`가 `env` 없음으로 분류 | **있다.** `X --version`으로 판정했는데 `env`는 `--version`을 안 받음 → `which`로 교체 |

그래서 `which` 판정에 **양성 대조군**도 넣었습니다: `node`는 이 프로브가 방금 실행한 바이너리이므로 "없음"으로 나오면 `broken`입니다. 인벤토리에는 `jsh`가 같은 역할을 합니다 — 지금 그걸 돌리고 있는데 목록에 없으면 파싱이 틀린 것입니다.
