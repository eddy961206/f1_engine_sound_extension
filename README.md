# F1 Engine Sound Extension

타이핑 속도를 기반으로 가상 F1 엔진 사운드를 재생하는 Chrome 확장 프로그램(MV3)입니다. 컨텐츠 스크립트에서 키 입력을 감지해 초당 타수(KPS)를 측정하고, 서비스 워커가 RPM/기어 상태를 계산하여 오프스크린 문서(Web Audio API)로 사운드를 제어합니다. 팝업과 옵션 페이지에서 ON/OFF, 볼륨, 민감도, 엔진 타입을 조절할 수 있습니다.

## 구조
- `manifest.json`: MV3 설정 및 권한 정의
- `background.js`: 엔진 상태 머신, 설정 동기화, 오프스크린 제어
- `content.js`: 키 입력 수집 및 KPS 계산
- `offscreen.html` / `offscreen.js`: Web Audio 기반 엔진 루프/변속음 재생
- `popup.html` / `popup.js`: 즉시 ON/OFF, 상태 확인, 볼륨 조절 UI
- `options.html` / `options.js`: 엔진 타입·기본 볼륨·민감도 설정 UI
- `assets/`: 사용자가 준비한 엔진 루프 및 변속 효과음 파일(저장만을 위한 폴더)
- `icons/` (gitignore 처리): 사용자 제공 확장 아이콘을 보관하는 폴더

### 아이콘 파일 준비
- 저작권 문제가 없는 PNG/SVG 아이콘을 `icons/` 폴더에 추가하고, 필요 시 `manifest.json`의 `action.default_icon` 또는 `icons` 필드를 수정하세요.
- 저장소에는 기본 아이콘이 포함되지 않으며 `.gitignore`에 의해 추적되지 않습니다. 배포 전 반드시 로컬에서 아이콘을 추가해야 합니다.

### 오디오 파일 준비
- 저장소에는 용량과 라이선스 문제로 MP3 샘플을 포함하지 않습니다. 엔진 타입별 다중 레이어 파일을 직접 추가해 주세요.
  - 엔진 타입 디렉토리 예시: `assets/v6/`, `assets/v8/`, `assets/v10/`, `assets/v12/`
  - 각 디렉토리에 다음 파일명을 채워 넣으면 됩니다(필수):
    - `engine_idle.mp3`
    - `engine_low.mp3`
    - `engine_mid.mp3`
    - `engine_high.mp3`
    - `engine_redline.mp3`
  - 변속 효과음(선택):
    - `assets/shift_up.mp3`
    - `assets/shift_down.mp3`
- 추천 소스: 직접 녹음(F1 25 게임 등)하거나, [Freesound F1 engine 검색 결과](https://freesound.org/search/?q=f1+engine)처럼 라이선스 허용 샘플을 내려받아 위 파일명으로 저장하면 됩니다.
- Web Audio 믹서는 RPM을 기준으로 인접 레이어 두 개만 크로스페이드하고, 변속 시 일시적인 볼륨/피치 딥을 적용합니다. 샘플 간 레벨과 루프 포인트를 비슷하게 맞출수록 더 자연스럽게 들립니다.

## 설치 및 테스트
1. Chrome 주소창에 `chrome://extensions` 입력 후 개발자 모드를 켭니다.
2. "압축 해제된 확장 프로그램을 로드"를 눌러 이 폴더를 선택합니다.
3. 아무 웹 페이지 텍스트 입력창에서 타이핑하여 엔진 사운드가 RPM/기어에 따라 변하는지 확인합니다.
4. 팝업에서 엔진 사운드를 켜고 끄거나, 현재 기어/RPM과 볼륨을 확인·조절합니다.
5. 옵션 페이지에서 엔진 타입, 기본 볼륨, 민감도를 조절한 뒤 저장합니다.

## 향후 개선 아이디어
- 실제 F1 엔진 샘플(기어/ RPM 구간별 다중 샘플) 로딩 및 크로스페이드
- 변속 효과음, 백파이어 등 원샷 사운드 자산 추가
- 키 종류별 민감도/가중치 반영, 커브 편집 UI 제공
- RPM/기어 히스토리 그래프, 키보드 오실로스코프 등 HUD 제공
