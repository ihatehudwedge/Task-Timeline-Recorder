/**
 * ============================================================================
 * [사용자 커스텀 영역] 자주 쓰는 타임라인 템플릿 문구 목록
 * 아래 배열에 원하는 문구를 추가/수정하면 좌측 수정 탭에 원클릭 버튼으로 생성됩니다.
 * ============================================================================
 */
const TIMELINE_TEMPLATES = [
  { label: "🚀 작업착수", text: "[작업착수] 작업 시작 및 사전 상태 점검 완료" },
  { label: "✅ 서비스 체크", text: "[서비스 체크] 서비스 정상 동작 확인 (특이사항 없음)" },
  { label: "📢 유관공유", text: "[유관부서 공유] 메신저 상황 공유 완료: " },
  { label: "⚠️ 이슈발생", text: "[이슈발생] 증상 및 원인 탐구 중: " },
  { label: "🔎 원인분석", text: "[원인분석] 장애 발생 원인 확인: " },
  { label: "🔄 롤백/보류", text: "[조치사항] 설정 원복 및 경과 모니터링 진행" },
  { label: "🏁 작업종료", text: "[작업종료] 최종 확인 완료 및 작업 종료" }
];

const STATUS_OPTIONS = ["대기", "진행", "이슈발생", "종료"];

// 전역 상태 관리 (샘플 없이 빈 배열로 시작)
let appData = {
  cards: []
};

let directoryHandle = null; // 공유 카드 폴더 핸들 (카드별 파편화 파일 저장용)
let currentFilterStatus = "ALL";
let editingCardId = null;
let draftStatus = "대기";
let draftTimeline = [];
let removedTimelineIdsInSession = new Set();

const LOCAL_STORAGE_KEY = "TASK_TIMELINE_FRAGMENTED_CACHE_V2";

// 초기 구동
window.addEventListener("DOMContentLoaded", () => {
  renderTemplateChips();
  loadInitialData();
  renderBoard();
});

// 1. 템플릿 칩 버튼 생성
function renderTemplateChips() {
  const container = document.getElementById("memoTemplateContainer");
  container.innerHTML = "";
  TIMELINE_TEMPLATES.forEach(tpl => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = tpl.label;
    btn.onclick = () => insertTemplateText(tpl.text);
    container.appendChild(btn);
  });
}

function insertTemplateText(text) {
  const textarea = document.getElementById("tlMemoInput");
  const cur = textarea.value.trim();
  textarea.value = cur ? (cur + "\n" + text) : text;
  textarea.focus();
}

// 2. 시간 포맷 헬퍼 (YYYY-MM-DD HH:MM)
function formatDateTime(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  const hh = String(dateObj.getHours()).padStart(2, "0");
  const mm = String(dateObj.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function setQuickTime(offsetMinutes) {
  const now = new Date();
  now.setMinutes(now.getMinutes() + offsetMinutes);
  document.getElementById("tlTimeInput").value = formatDateTime(now);
}

// 3. 초기 데이터 로드 (샘플 없이 로컬 캐시만 확인)
function loadInitialData() {
  const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed.cards)) {
        appData.cards = parsed.cards;
      }
    } catch (e) {
      console.error("로컬 캐시 로드 실패", e);
    }
  }
}

function saveToLocalCache() {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(appData));
}

// 4. 카드별 개별 파일 파편화 관리 (공유 폴더 연결 방식)
function getCardFileName(cardId) {
  const safeId = String(cardId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeId}.json`;
}

async function connectCardDirectory() {
  if (!window.showDirectoryPicker) {
    showToast("현재 브라우저는 폴더 직접 연결을 지원하지 않습니다. [카드 파일 불러오기]를 이용해주세요.", "warn");
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker({
      mode: "readwrite"
    });
    directoryHandle = dirHandle;
    await loadAllCardsFromDirectory();
    updateFolderStatusUI(dirHandle.name);
    showToast(`'${dirHandle.name}' 카드 폴더가 연결되었습니다.`, "success");
  } catch (err) {
    if (err.name !== "AbortError") {
      showToast("카드 폴더 연결 실패: " + err.message, "warn");
    }
  }
}

async function loadAllCardsFromDirectory() {
  if (!directoryHandle) return;
  const loadedCards = [];

  for await (const entry of directoryHandle.values()) {
    if (entry.kind === "file" && (entry.name.endsWith(".json") || entry.name.endsWith(".card"))) {
      try {
        const file = await entry.getFile();
        const text = await file.text();
        if (!text.trim()) continue;
        const parsed = JSON.parse(text);

        if (parsed && parsed.id && parsed.title !== undefined) {
          if (!Array.isArray(parsed.timeline)) parsed.timeline = [];
          loadedCards.push(parsed);
        } else if (parsed && Array.isArray(parsed.cards)) {
          parsed.cards.forEach(c => {
            if (c && c.id) loadedCards.push(c);
          });
        }
      } catch (e) {
        console.warn(`카드 파일 읽기 건너뜀 (${entry.name}):`, e);
      }
    }
  }

  loadedCards.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  appData.cards = loadedCards;
  saveToLocalCache();
  renderBoard();
}

async function reloadCardsFromDirectory() {
  if (!directoryHandle) {
    showToast("먼저 상단의 [공유 카드 폴더 연결]로 폴더를 지정해주세요.", "warn");
    return;
  }
  try {
    await loadAllCardsFromDirectory();
    if (editingCardId) {
      const latestCard = appData.cards.find(c => c.id === editingCardId);
      if (latestCard) {
        openDrawerForEditCard(editingCardId, false);
      }
    }
    showToast("폴더 내 모든 카드 파일의 최신 상태를 불러왔습니다.", "success");
  } catch (err) {
    showToast("카드 목록 새로고침 실패: " + err.message, "warn");
  }
}

/**
 * [핵심] 특정 카드 1개만 개별 파일로 저장 및 병합
 */
async function saveSingleCardFileToDirectory(cardObj, customToastMsg = null) {
  if (!directoryHandle) {
    saveToLocalCache();
    renderBoard();
    showToast(customToastMsg || "카드가 저장되었습니다.", "success");
    return;
  }

  try {
    const fileName = getCardFileName(cardObj.id);
    let finalCard = { ...cardObj };

    // 기존에 해당 카드 파일이 폴더에 있는지 확인하여 타임라인 병합
    try {
      const existingFileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
      const existingFile = await existingFileHandle.getFile();
      const existingText = await existingFile.text();
      if (existingText.trim()) {
        const diskCard = JSON.parse(existingText);
        if (diskCard && Array.isArray(diskCard.timeline)) {
          const mergedMap = new Map();
          (cardObj.timeline || []).forEach(tl => mergedMap.set(tl.id, tl));
          diskCard.timeline.forEach(diskTl => {
            if (!mergedMap.has(diskTl.id) && !removedTimelineIdsInSession.has(diskTl.id)) {
              mergedMap.set(diskTl.id, diskTl);
            }
          });
          finalCard.timeline = Array.from(mergedMap.values()).sort((a, b) =>
            (b.time || "").localeCompare(a.time || "")
          );
        }
      }
    } catch (notFoundErr) {
      // 신규 카드 파일인 경우 패스
    }

    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(finalCard, null, 2));
    await writable.close();

    const idx = appData.cards.findIndex(c => c.id === finalCard.id);
    if (idx !== -1) {
      appData.cards[idx] = finalCard;
    } else {
      appData.cards.unshift(finalCard);
    }

    saveToLocalCache();
    renderBoard();
    showToast(customToastMsg || `카드 파일(${fileName})이 공유 폴더에 저장되었습니다.`, "success");
  } catch (err) {
    console.error(err);
    showToast("카드 파일 저장 중 오류 발생: " + err.message, "warn");
  }
}

async function deleteSingleCardFileFromDirectory(cardId) {
  if (!directoryHandle) {
    saveToLocalCache();
    renderBoard();
    showToast(`카드(${cardId})가 삭제되었습니다.`, "success");
    return;
  }

  try {
    const fileName = getCardFileName(cardId);
    await directoryHandle.removeEntry(fileName);
    saveToLocalCache();
    renderBoard();
    showToast(`공유 폴더에서 카드 파일(${fileName})이 삭제되었습니다.`, "success");
  } catch (err) {
    saveToLocalCache();
    renderBoard();
    showToast(`카드 목록에서 삭제되었습니다.`, "success");
  }
}

function updateFolderStatusUI(folderName) {
  const badge = document.getElementById("folderStatusBadge");
  const text = document.getElementById("folderStatusText");
  badge.classList.add("connected");
  text.textContent = `연결된 카드 폴더: ${folderName}`;
}

// 5. 개별 카드 파일 직접 불러오기
function triggerImportCardFiles() {
  document.getElementById("cardFilesInput").click();
}

async function handleImportCardFiles(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  let importedCount = 0;
  for (const file of files) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (parsed && parsed.id && parsed.title !== undefined) {
        upsertCardInMemory(parsed);
        importedCount++;
      } else if (parsed && Array.isArray(parsed.cards)) {
        parsed.cards.forEach(c => {
          if (c && c.id) {
            upsertCardInMemory(c);
            importedCount++;
          }
        });
      }
    } catch (e) {
      console.warn("카드 파일 불러오기 실패:", file.name);
    }
  }

  saveToLocalCache();
  renderBoard();
  showToast(`${importedCount}개의 카드를 불러왔습니다.`, "success");
  event.target.value = "";
}

function upsertCardInMemory(cardObj) {
  if (!Array.isArray(cardObj.timeline)) cardObj.timeline = [];
  const idx = appData.cards.findIndex(c => c.id === cardObj.id);
  if (idx !== -1) {
    appData.cards[idx] = cardObj;
  } else {
    appData.cards.unshift(cardObj);
  }
}

// 6. 카드에서 수정 버튼 없이 즉시 작업 현황(Status) 변경
async function changeCardStatusDirect(cardId, newStatus) {
  const card = appData.cards.find(c => c.id === cardId);
  if (!card) return;

  card.status = newStatus;
  card.updatedAt = formatDateTime(new Date());

  // 만약 왼쪽 수정 탭에서 동일 카드를 열어둔 상태라면 탭 내부의 상태 버튼도 동기화
  if (editingCardId === cardId) {
    selectEditStatus(newStatus);
  }

  await saveSingleCardFileToDirectory(card, `${cardId} 상태가 [${newStatus}](으)로 변경되었습니다.`);
}

// 7. 보드 렌더링 및 필터링
function setStatusFilter(status) {
  currentFilterStatus = status;
  document.querySelectorAll("#statusFilterGroup .filter-pill").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-filter") === status);
  });
  renderBoard();
}

function updateWorkerDropdown() {
  const select = document.getElementById("workerFilterSelect");
  const prevValue = select.value;
  const workers = new Set();
  appData.cards.forEach(c => {
    if (c.worker && c.worker.trim()) workers.add(c.worker.trim());
  });

  select.innerHTML = `<option value="ALL">모든 작업자 (${workers.size}명)</option>`;
  Array.from(workers).sort().forEach(w => {
    const opt = document.createElement("option");
    opt.value = w;
    opt.textContent = `작업자: ${w}`;
    select.appendChild(opt);
  });

  if ([...workers].includes(prevValue)) {
    select.value = prevValue;
  } else {
    select.value = "ALL";
  }
}

function renderBoard() {
  updateWorkerDropdown();

  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const selectedWorker = document.getElementById("workerFilterSelect").value;

  const counts = { ALL: appData.cards.length, "대기": 0, "진행": 0, "이슈발생": 0, "종료": 0 };
  appData.cards.forEach(c => {
    if (counts[c.status] !== undefined) counts[c.status]++;
  });

  document.getElementById("summaryCounts").innerHTML = `
    <span>전체 카드 <b>${counts.ALL}</b></span>
    <span>대기 <b>${counts["대기"]}</b></span>
    <span style="color:var(--status-prog-text)">진행 <b>${counts["진행"]}</b></span>
    <span style="color:var(--status-issue-text)">이슈발생 <b>${counts["이슈발생"]}</b></span>
    <span style="color:var(--status-done-text)">종료 <b>${counts["종료"]}</b></span>
  `;

  const filtered = appData.cards.filter(card => {
    if (currentFilterStatus !== "ALL" && card.status !== currentFilterStatus) return false;
    if (selectedWorker !== "ALL" && (card.worker || "").trim() !== selectedWorker) return false;
    if (query) {
      const hayTitle = (card.title || "").toLowerCase();
      const hayWorker = (card.worker || "").toLowerCase();
      const hayAuthor = (card.author || "").toLowerCase();
      const hayId = (card.id || "").toLowerCase();
      const hayTl = (card.timeline || []).map(t => `${t.author} ${t.content} ${t.time}`).join(" ").toLowerCase();
      if (!hayTitle.includes(query) && !hayWorker.includes(query) && !hayAuthor.includes(query) && !hayId.includes(query) && !hayTl.includes(query)) {
        return false;
      }
    }
    return true;
  });

  const grid = document.getElementById("cardsGrid");
  grid.innerHTML = "";

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-board" style="grid-column: 1 / -1;">
        <p style="font-size:15px; font-weight:700; margin-bottom:6px;">등록된 작업 카드가 없습니다.</p>
        <p style="font-size:13px;">상단의 [공유 카드 폴더 연결]로 카드 폴더를 불러오거나 [+ 새 카드 등록] 버튼을 눌러 새 카드를 작성하세요.</p>
      </div>
    `;
    return;
  }

  filtered.forEach(card => {
    const curStatus = card.status || "대기";
    const cardEl = document.createElement("div");
    cardEl.className = "task-card" + (card.id === editingCardId ? " active-editing" : "");
    cardEl.setAttribute("data-status", curStatus);

    const sortedTl = [...(card.timeline || [])].sort((a, b) => (b.time || "").localeCompare(a.time || ""));
    let tlHtml = "";
    if (sortedTl.length === 0) {
      tlHtml = `<div class="card-empty-tl">등록된 타임라인 메모가 없습니다.</div>`;
    } else {
      tlHtml = sortedTl.map(tl => `
        <div class="tl-entry">
          <div class="tl-meta">
            <span class="tl-time">${escapeHtml(tl.time)}</span>
            <span class="tl-writer">${escapeHtml(tl.author || "미상")}</span>
          </div>
          <div class="tl-text">${escapeHtml(tl.content)}</div>
        </div>
      `).join("");
    }

    const statusOptionsHtml = STATUS_OPTIONS.map(st =>
      `<option value="${st}" ${st === curStatus ? "selected" : ""}>${st}</option>`
    ).join("");

    cardEl.innerHTML = `
      <div class="card-top">
        <div>
          <span class="card-id-badge">${escapeHtml(card.id)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <select class="card-status-select" data-status="${escapeHtml(curStatus)}" onchange="changeCardStatusDirect('${escapeHtml(card.id)}', this.value)" title="클릭하여 작업 현황을 즉시 변경합니다">
            ${statusOptionsHtml}
          </select>
          <button class="btn btn-sm" onclick="openDrawerForEditCard('${escapeHtml(card.id)}')">
            ✎ 수정
          </button>
        </div>
      </div>

      <div class="card-title">${escapeHtml(card.title)}</div>

      <div class="card-meta">
        <div class="meta-people">
          <span class="meta-item">
            <span class="meta-label">작업자:</span>
            <span class="meta-val">${escapeHtml(card.worker || "-")}</span>
          </span>
          <span class="meta-item">
            <span class="meta-label">작성자:</span>
            <span class="meta-val">${escapeHtml(card.author || "-")}</span>
          </span>
        </div>
        <span>로그 ${sortedTl.length}건</span>
      </div>

      <div class="card-timeline">
        ${tlHtml}
      </div>

      <div class="card-footer">
        <span>최근 수정: ${escapeHtml(card.updatedAt || "-")}</span>
        <span>파일명: ${escapeHtml(getCardFileName(card.id))}</span>
      </div>
    `;

    grid.appendChild(cardEl);
  });
}

// 8. 왼쪽 수정 탭 (Left Drawer) 제어 로직
function openDrawerForNewCard() {
  editingCardId = null;
  removedTimelineIdsInSession.clear();
  draftStatus = "대기";
  draftTimeline = [];

  document.getElementById("drawerModeTitle").textContent = "새 카드 등록";
  document.getElementById("drawerCardId").textContent = "NEW";
  document.getElementById("editTitle").value = "";
  document.getElementById("editWorker").value = "";
  document.getElementById("editAuthor").value = "";
  document.getElementById("deleteCardBtn").style.display = "none";

  selectEditStatus("대기");
  setQuickTime(0);
  document.getElementById("tlAuthorInput").value = "";
  document.getElementById("tlMemoInput").value = "";

  renderDrawerTimelineList();
  document.getElementById("leftDrawer").classList.add("open");
  renderBoard();
  setTimeout(() => document.getElementById("editTitle").focus(), 150);
}

function openDrawerForEditCard(cardId, focusMemo = false) {
  const card = appData.cards.find(c => c.id === cardId);
  if (!card) return;

  editingCardId = card.id;
  removedTimelineIdsInSession.clear();
  draftStatus = card.status || "대기";
  draftTimeline = JSON.parse(JSON.stringify(card.timeline || []));

  document.getElementById("drawerModeTitle").textContent = "카드 수정 및 타임라인 기록";
  document.getElementById("drawerCardId").textContent = card.id;
  document.getElementById("editTitle").value = card.title || "";
  document.getElementById("editWorker").value = card.worker || "";
  document.getElementById("editAuthor").value = card.author || "";
  document.getElementById("deleteCardBtn").style.display = "inline-flex";

  selectEditStatus(draftStatus);
  setQuickTime(0);
  document.getElementById("tlAuthorInput").value = card.worker || card.author || "";
  document.getElementById("tlMemoInput").value = "";

  renderDrawerTimelineList();
  document.getElementById("leftDrawer").classList.add("open");
  renderBoard();
  if (focusMemo) {
    setTimeout(() => document.getElementById("tlMemoInput").focus(), 150);
  }
}

function closeDrawer() {
  editingCardId = null;
  document.getElementById("leftDrawer").classList.remove("open");
  renderBoard();
}

function selectEditStatus(status) {
  draftStatus = status;
  document.querySelectorAll("#editStatusSelector .status-opt-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.getAttribute("data-status") === status);
  });
}

function handleMemoKeydown(e) {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    addTimelineEntryInDrawer();
  }
}

function addTimelineEntryInDrawer() {
  const timeVal = document.getElementById("tlTimeInput").value.trim() || formatDateTime(new Date());
  const authorVal = document.getElementById("tlAuthorInput").value.trim() ||
                    document.getElementById("editWorker").value.trim() ||
                    document.getElementById("editAuthor").value.trim() || "담당자";
  const memoVal = document.getElementById("tlMemoInput").value.trim();

  if (!memoVal) {
    showToast("타임라인 메모 내용을 입력해주세요.", "warn");
    document.getElementById("tlMemoInput").focus();
    return;
  }

  const newTl = {
    id: "TL-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    time: timeVal,
    author: authorVal,
    content: memoVal
  };

  draftTimeline.unshift(newTl);
  document.getElementById("tlMemoInput").value = "";
  setQuickTime(0);
  renderDrawerTimelineList();
}

function renderDrawerTimelineList() {
  const listEl = document.getElementById("drawerTimelineList");
  const countEl = document.getElementById("drawerTlCount");

  draftTimeline.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  countEl.textContent = draftTimeline.length;

  if (draftTimeline.length === 0) {
    listEl.innerHTML = `<div class="card-empty-tl" style="text-align:center; padding:14px;">아직 등록된 타임라인 이력이 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = draftTimeline.map(tl => `
    <div class="drawer-tl-item">
      <div class="drawer-tl-header">
        <div>
          <span class="drawer-tl-time">${escapeHtml(tl.time)}</span>
          <span style="margin:0 4px;">·</span>
          <span class="drawer-tl-author">${escapeHtml(tl.author)}</span>
        </div>
        <div class="drawer-tl-actions">
          <button type="button" class="icon-btn" onclick="editTimelineItem('${escapeHtml(tl.id)}')">수정</button>
          <button type="button" class="icon-btn del" onclick="removeTimelineItem('${escapeHtml(tl.id)}')">삭제</button>
        </div>
      </div>
      <div class="drawer-tl-content">${escapeHtml(tl.content)}</div>
    </div>
  `).join("");
}

function editTimelineItem(tlId) {
  const item = draftTimeline.find(t => t.id === tlId);
  if (!item) return;
  document.getElementById("tlTimeInput").value = item.time;
  document.getElementById("tlAuthorInput").value = item.author;
  document.getElementById("tlMemoInput").value = item.content;
  draftTimeline = draftTimeline.filter(t => t.id !== tlId);
  removedTimelineIdsInSession.add(tlId);
  renderDrawerTimelineList();
  document.getElementById("tlMemoInput").focus();
}

function removeTimelineItem(tlId) {
  draftTimeline = draftTimeline.filter(t => t.id !== tlId);
  removedTimelineIdsInSession.add(tlId);
  renderDrawerTimelineList();
}

// 9. 카드 개별 저장 및 삭제
async function saveCardAndSync() {
  const title = document.getElementById("editTitle").value.trim();
  const worker = document.getElementById("editWorker").value.trim();
  const author = document.getElementById("editAuthor").value.trim();

  if (!title) {
    showToast("작업명을 입력해주세요.", "warn");
    document.getElementById("editTitle").focus();
    return;
  }

  const pendingMemo = document.getElementById("tlMemoInput").value.trim();
  if (pendingMemo) {
    addTimelineEntryInDrawer();
  }

  const nowStr = formatDateTime(new Date());
  let targetCard;

  if (editingCardId) {
    targetCard = {
      id: editingCardId,
      title,
      status: draftStatus,
      worker,
      author,
      updatedAt: nowStr,
      timeline: [...draftTimeline]
    };
    const idx = appData.cards.findIndex(c => c.id === editingCardId);
    if (idx !== -1) {
      appData.cards[idx] = targetCard;
    } else {
      appData.cards.unshift(targetCard);
    }
  } else {
    const nextNum = getNextTaskNumber();
    targetCard = {
      id: `TASK-${nextNum}`,
      title,
      status: draftStatus,
      worker,
      author,
      updatedAt: nowStr,
      timeline: [...draftTimeline]
    };
    appData.cards.unshift(targetCard);
    editingCardId = targetCard.id;
  }

  await saveSingleCardFileToDirectory(targetCard);
  closeDrawer();
}

async function deleteCurrentCard() {
  if (!editingCardId) return;
  if (!confirm(`정말 이 카드(${editingCardId})를 삭제하시겠습니까?`)) return;

  const delId = editingCardId;
  appData.cards = appData.cards.filter(c => c.id !== delId);

  await deleteSingleCardFileFromDirectory(delId);
  closeDrawer();
}

function getNextTaskNumber() {
  let max = 100;
  appData.cards.forEach(c => {
    const match = String(c.id).match(/TASK-(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  });
  return max + 1;
}

// 유틸리티
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(msg, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.25s";
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}