const css = (value) => () => globalThis.CSS?.supports(value) ?? false;
const api = (detect) => () => Boolean(detect(globalThis));
const definitions = [
  ["highlight", api((g) => g.CSS?.highlights && g.Highlight), "개수·이동·결과 목록", "DOM 불변"],
  ["highlightsFromPoint", api((g) => g.CSS?.highlights?.highlightsFromPoint), "caret hit-test", "메모 열기"],
  ["anchorPositioning", css("anchor-name: --anchor"), "JS 좌표", "메뉴 사용"],
  ["popover", api((g) => g.HTMLElement?.prototype.showPopover), "click·backdrop", "닫기 가능"],
  ["closeWatcher", api((g) => g.CloseWatcher), "닫기 버튼 + Esc", "닫기 가능"],
  ["viewTransitions", api((g) => g.document?.startViewTransition), "즉시 전환", "이동"],
  ["scrollend", api((g) => "onscrollend" in (g.document || {})), "scroll 이벤트", "진행 표시"],
  ["scrollDriven", css("animation-timeline: scroll()"), "JS / 정적", "진행 표시"],
  ["scrollState", css("container-type: scroll-state"), "IntersectionObserver", "헤더 표시"],
  ["containerQueries", css("container-type: inline-size"), "미디어 쿼리", "레이아웃"],
  ["scope", api((g) => g.CSSScopeRule), "구체적 선택자", "AA 격자"],
  ["layer", api((g) => g.CSSLayerBlockRule), "일반 CSS", "레이아웃"],
  ["lightDark", css("color: light-dark(white, black)"), "테마별 토큰", "대비"],
  ["startingStyle", api((g) => g.CSSStartingStyleRule), "즉시 표시", "동작"],
  ["textBoxTrim", css("text-box-trim: trim-both"), "기존 높이", "라벨"],
  ["fieldSizing", css("field-sizing: content"), "고정 rows", "입력"],
  ["contentVisibility", css("content-visibility: auto"), "전체 DOM", "목록"],
  ["untilFound", api((g) => g.document && "onbeforematch" in g.document.createElement("div")), "hidden + 펼침 버튼", "댓글 접근"],
  ["virtualKeyboard", api((g) => g.navigator?.virtualKeyboard), "visualViewport", "입력"],
  ["fullscreen", api((g) => g.document?.fullscreenEnabled), "일반 화면", "AA 도구"],
  ["orientationLock", api((g) => g.screen?.orientation?.lock), "회전 안내", "전체화면"],
  ["vibration", api((g) => g.navigator?.vibrate), "진동 없음", "동작"],
  ["wakeLock", api((g) => g.navigator?.wakeLock), "화면 켜 두기 숨김", "읽기"],
  ["tts", api((g) => g.speechSynthesis && g.SpeechSynthesisUtterance), "기능 숨김", "읽기"],
  ["mediaSession", api((g) => g.navigator?.mediaSession), "본문 도구", "듣기 제어"],
  ["shareFiles", api((g) => g.navigator?.canShare && g.navigator?.share), "다운로드", "공유"],
  ["clipboard", api((g) => g.navigator?.clipboard?.writeText), "선택·다운로드", "발췌 보존"],
  ["serviceWorker", api((g) => g.navigator?.serviceWorker && g.caches), "온라인 전용", "읽기"],
  ["indexedDB", api((g) => g.indexedDB), "저장 실패 안내", "기록 유실 없음"],
  ["storagePersist", api((g) => g.navigator?.storage?.persist), "용량 안내", "저장 상태"],
  ["storageEstimate", api((g) => g.navigator?.storage?.estimate), "추정 크기", "저장 상태"],
  ["webLocks", api((g) => g.navigator?.locks?.request), "IDB 트랜잭션·재조정", "기록 보존"],
  ["broadcastChannel", api((g) => g.BroadcastChannel), "storage event", "변경 알림"],
];

export const capabilities = Object.fromEntries(definitions.map(([id, detect, fallback, keeps]) => [id, {
  id, detect, minVerified: "", fixture: `capability:${id}:off`, fallback, keeps,
}]));

export const FLAG_NAMES = ["newShell", "miniBar", "typeCovers", "barcode", "find", "annotations", "pageMode", "quickSettings", "gallery",
  "aaGestures", "aaFullscreen", "tts", "stats", "offline", "sync", "kwic", "glass", "haptics"];

export function featureEnabled(name, defaultValue = false) {
  if (!FLAG_NAMES.includes(name) || name === "sync") return false;
  try {
    const value = JSON.parse(localStorage.getItem("redstm.flags"))?.[name];
    if (typeof value === "boolean") return value;
  } catch { /* invalid flags use the safe default */ }
  // A caller must explicitly opt in until its platform combination is verified on the phone.
  return defaultValue;
}
