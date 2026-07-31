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

| 그룹        | 확인 항목                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 환경        | 교차 출처 격리 여부, `workdir`, 기본 `PATH`, **PATH 디렉터리를 실제로 `readdir`해서 얻은 전체 바이너리 목록**                                                                |
| 셸          | `jsh`/`sh`/`bash`/`zsh`/`ash`/`dash` 중 무엇이 대화형으로 뜨는가                                                                                                             |
| 바이너리    | `node`, `npm`, `git`, `curl`, `vi`, `python3`, `gcc` 등이 있는가                                                                                                             |
| **PTY**     | stdin으로 친 명령이 실제로 실행되는가 / 입력이 에코되는가 / ANSI 이스케이프가 오는가 / `cd` 상태가 입력 사이에 유지되는가 / **Ctrl-C가 포그라운드만 죽이고 셸은 살아남는가** |
| 터미널 제어 | `terminal: {cols,rows}`가 프로세스가 보는 폭에 반영되는가, `resize()`가 실행 중인 프로세스에 resize 이벤트로 도달하는가                                                      |
| spawn 옵션  | `cwd`, `env`가 반영되는가, 두 프로세스가 동시에 도는가                                                                                                                       |

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
- `binaries.probe`의 `absent` 목록이 "리눅스 박스에 SSH"와 "Node 샌드박스에 SSH" 사이 어디쯤인지를 알려줍니다.

## 이 저장소 샌드박스에서의 상태

여기서는 **부팅이 안 됩니다** — StackBlitz 런타임 호스트가 403입니다. 확인된 데까지는:

- 페이지·`probe.js`·`@webcontainer/api` 모듈 16개 전부 200으로 로드
- `env.isolated` **pass** — COOP/COEP가 실제로 걸려 있고 `SharedArrayBuffer`가 살아 있음
- `WebContainer.boot()`에서 멈추고, 원인을 지목한 메시지로 중단

따라서 **실측은 로컬에서** 해야 합니다. 부팅은 실패해도 그냥 멎을 뿐 reject하지 않아서, 프로브가 직접 타임아웃을 걸고 원인 후보(네트워크 / 교차 출처 격리)를 찍어줍니다.
